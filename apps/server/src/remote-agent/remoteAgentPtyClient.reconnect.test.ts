import { afterEach, expect, it, vi } from "vitest";
import type { RemoteAgentConnection } from "./remoteAgentConnection";
import type { RemoteAgentFrame } from "./remoteAgentProtocol";
import { RemoteAgentPtyProcess, remoteAgentPtyReconnectTiming } from "./remoteAgentPtyClient";
import { reconnectRemotePty } from "./remoteAgentPtyClient.reconnect";
import { attachRemotePty } from "./remoteAgentPtyClient.attach";
import { createRemotePtyResizeControl } from "./remoteAgentPtyClient.controls";

afterEach(() => {
  delete remoteAgentPtyReconnectTiming.delay;
  vi.restoreAllMocks();
});

it("cancels a stalled shared acquisition without closing it or attaching late", async () => {
  let resolve!: (connection: RemoteAgentConnection) => void;
  const connect = vi.fn(
    () =>
      new Promise<RemoteAgentConnection>((done) => {
        resolve = done;
      }),
  );
  const attach = vi.fn(async () => {});
  const controller = new AbortController();
  const pending = reconnectRemotePty({
    connect,
    attach,
    signal: controller.signal,
    cancelled: () => controller.signal.aborted,
    delay: async () => {},
  });
  controller.abort();
  expect((await pending).status).toBe("cancelled");
  const close = vi.fn();
  resolve({ close } as unknown as RemoteAgentConnection);
  await Promise.resolve();
  expect(attach).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledOnce();
});

it("bounds an attached-but-silent transport and cancels its observation", async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const request = vi.fn(
    (_frame: unknown, _matches: unknown, signal: AbortSignal) =>
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
      }),
  );
  const observed = vi.fn();
  const pending = attachRemotePty(
    { request } as unknown as RemoteAgentConnection,
    "pty",
    0,
    observed,
    vi.fn(),
    vi.fn(),
  );
  const rejection = expect(pending).rejects.toThrow("deadline");
  deadline.abort();
  await rejection;
  expect(timeout).toHaveBeenCalledWith(15_000);
  expect(observed).not.toHaveBeenCalled();
});

it("manual reopening starts a new bounded attach-only episode after exhaustion", async () => {
  remoteAgentPtyReconnectTiming.delay = async () => {};
  let failed!: (error: Error) => void;
  const old = {
    onFrame: () => () => {},
    onFailure: (callback: typeof failed) => {
      failed = callback;
      return () => {};
    },
  } as unknown as RemoteAgentConnection;
  const request = vi.fn(async (frame: RemoteAgentFrame) => {
    if (frame.type !== "ptyAttachRequest") throw new Error("No launch or input replay allowed");
    return {
      type: "ptyAttachResponse",
      value: {
        ...frame.value,
        state: "running",
        pid: 42,
        nextSequence: 1,
        firstRetainedSequence: 1,
        replayGap: false,
      },
    } as RemoteAgentFrame;
  });
  const replacement = {
    request,
    onFrame: () => () => {},
    onFailure: () => () => {},
  } as unknown as RemoteAgentConnection;
  const reconnect = vi
    .fn<() => Promise<RemoteAgentConnection>>()
    .mockRejectedValue(new Error("network unavailable"));
  const process = new RemoteAgentPtyProcess(old, "pty", reconnect);
  const errors: string[] = [];
  process.onError((error) => errors.push(error.message));
  failed(new Error("network lost"));
  await vi.waitFor(() =>
    expect(errors.some((message) => message.includes("attempts exhausted"))).toBe(true),
  );
  expect(reconnect).toHaveBeenCalledTimes(10);
  expect(request).not.toHaveBeenCalled();
  reconnect.mockResolvedValue(replacement);
  await process.retryRecovery();
  expect(reconnect).toHaveBeenCalledTimes(11);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0]?.[0]).toMatchObject({
    type: "ptyAttachRequest",
    value: { ptyId: "pty" },
  });
  await process.retryRecovery();
  expect(reconnect).toHaveBeenCalledTimes(11);
  process.detach();
});

it("coalesces resize floods and cancels outstanding observation on detach", async () => {
  const signals: AbortSignal[] = [];
  const frames: RemoteAgentFrame[] = [];
  const request = vi.fn(
    (frame: RemoteAgentFrame, _matches: unknown, signal: AbortSignal) =>
      new Promise<never>((_, reject) => {
        frames.push(frame);
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
  );
  const failed = vi.fn();
  const control = createRemotePtyResizeControl(
    "pty",
    () => ({ request }) as unknown as RemoteAgentConnection,
    failed,
  );
  for (let cols = 1; cols <= 10_000; cols++) control.push({ cols, rows: 24 });
  expect(frames).toHaveLength(1);
  control.stop();
  expect(signals[0]?.aborted).toBe(true);
  await Promise.resolve();
  await Promise.resolve();
  expect(failed).not.toHaveBeenCalled();
});
