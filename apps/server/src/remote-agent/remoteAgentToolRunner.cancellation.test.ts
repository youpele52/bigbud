import { expect, it, vi } from "vitest";
import { makeRemoteAgentToolRunner } from "./remoteAgentToolRunner.ts";
import { RemoteAgentProcessClient } from "./remoteAgentProcessClient.ts";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";

it("cancels the exact process and waits for terminal evidence rather than the cancellation-requested reply", async () => {
  let complete!: () => void;
  let operation = "";
  const request = vi.fn(async (frame: RemoteAgentFrame) => {
    if (frame.type === "workspaceOpenRequest")
      return {
        type: "workspaceOpenResponse",
        value: { ...frame.value, accepted: true, errorCode: "", errorMessage: "" },
      };
    if (frame.type === "processRequest") {
      operation = frame.value.operationId;
      return {
        type: "processAccepted",
        value: {
          ...frame.value,
          accepted: true,
          duplicate: false,
          errorCode: "",
          errorMessage: "",
        },
      };
    }
    if (frame.type === "cancelRequest")
      return {
        type: "cancelResponse",
        value: {
          ...frame.value,
          cancelled: true,
          terminal: false,
          detail: "cancellation-requested",
        },
      };
    throw new Error("unexpected frame");
  });
  const connection = {
    request,
    nextFrame: async () => {
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return {
        type: "processCompleted",
        value: {
          requestId: "r",
          operationId: operation,
          state: "cancelled",
          hasExitCode: false,
          exitCode: 0,
          outputTruncated: false,
          errorCode: "CANCELLED",
          errorMessage: "cancelled",
        },
      };
    },
  } as unknown as RemoteAgentConnection;
  const client = new RemoteAgentProcessClient(connection);
  const controller = new AbortController();
  const runner = makeRemoteAgentToolRunner({ resolve: async () => client });
  let settled = false;
  const running = runner({
    executionTargetId: "ssh:fixture",
    cwd: "/srv/project",
    invocationId: "owned-call",
    command: "sleep",
    signal: controller.signal,
  });
  const observed = running.finally(() => {
    settled = true;
  });
  const rejected = expect(observed).rejects.toThrow("cancelled");
  await expect.poll(() => !!complete).toBe(true);
  controller.abort();
  await expect
    .poll(() => request.mock.calls.some(([frame]) => frame.type === "cancelRequest"))
    .toBe(true);
  expect(settled).toBe(false);
  expect(request).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "cancelRequest",
      value: expect.objectContaining({ operationId: "owned-call" }),
    }),
    expect.any(Function),
  );
  complete();
  await rejected;
  expect(settled).toBe(true);
});

it("passes cancellation authority to the durable owned process without changing the invocation identity", async () => {
  const controller = new AbortController();
  const runOwned = vi.fn(async () => {
    throw new Error("fixture ended");
  });
  const resolve = vi.fn();
  const runner = makeRemoteAgentToolRunner({ runOwned, resolve });
  await expect(
    runner({
      executionTargetId: "ssh:fixture",
      cwd: "/srv/project",
      invocationId: "durable",
      command: "sleep",
      signal: controller.signal,
    }),
  ).rejects.toThrow("fixture ended");
  expect(runOwned).toHaveBeenCalledWith(
    expect.objectContaining({
      ownerKey: "tool:durable",
      invocationId: "durable",
      cancelOnAbort: true,
      request: expect.objectContaining({ operationId: "durable", signal: controller.signal }),
    }),
  );
  expect(resolve).not.toHaveBeenCalled();
});

it("rejects pre-cancelled requests before opening a remote connection", async () => {
  const controller = new AbortController();
  controller.abort();
  const resolve = vi.fn();
  const runner = makeRemoteAgentToolRunner({ resolve });
  await expect(
    runner({
      executionTargetId: "ssh:fixture",
      cwd: "/srv/project",
      command: "sleep",
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
});
