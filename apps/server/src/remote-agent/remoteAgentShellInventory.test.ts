import { describe, expect, it, vi } from "vitest";
import { runRemoteAgentShellInventory } from "./remoteAgentShellInventory.ts";
import type { RemoteAgentProcessResult } from "./remoteAgentProcessClient.types.ts";
import {
  remoteAgentProcessRequestDigest,
  remoteAgentWorkspaceHandle,
} from "./remoteAgentProcessRequest.ts";

const output = (overrides: Partial<RemoteAgentProcessResult> = {}): RemoteAgentProcessResult => ({
  accepted: true,
  duplicate: false,
  stdout: new TextEncoder().encode("inventory\0"),
  stderr: new Uint8Array(),
  completed: {
    requestId: "request",
    operationId: "operation",
    state: "completed",
    hasExitCode: true,
    exitCode: 0,
    outputTruncated: false,
    errorCode: "",
    errorMessage: "",
  },
  ...overrides,
});
const fixture = () => {
  const controller = new AbortController();
  const input = {
    executionTargetId: "ssh:host=example.test&user=alice&transport=agent",
    args: [
      "-i",
      "PATH=/usr/bin:/bin",
      "LC_ALL=C",
      "/bin/sh",
      "-c",
      "static-probe",
      "sh",
      "ssh",
      "alice",
    ],
    signal: controller.signal,
    timeoutMs: 10000,
    maxBufferBytes: 8192,
  };
  const process = {
    run: vi.fn(async (_input: unknown) => output()),
    cancelAndWait: vi.fn(async (_input: unknown) => ({
      requestId: "cancel",
      operationId: "operation",
      cancelled: true,
      terminal: true,
      detail: "terminal",
    })),
  };
  const openWorkspace = vi.fn(async (_handle: string, _cwd: string) => {});
  const resolve = vi.fn(async (_target: string) => ({ process, openWorkspace }));
  return { input, process, openWorkspace, resolve, controller };
};

describe("raw authenticated shell inventory process lane", () => {
  it("opens only host root, sends bounded env command without workspace environment, and hashes the request", async () => {
    const f = fixture();
    const result = await runRemoteAgentShellInventory(f.input, f);
    const workspaceHandle = remoteAgentWorkspaceHandle({ ...f.input, cwd: "/" });
    expect(f.resolve).toHaveBeenCalledExactlyOnceWith(f.input.executionTargetId);
    expect(f.openWorkspace).toHaveBeenCalledExactlyOnceWith(workspaceHandle, "/");
    expect(result).toMatchObject({ stdout: "inventory\0", code: 0 });
    expect(f.process.run).toHaveBeenCalledExactlyOnceWith({
      workspaceHandle,
      operationId: expect.stringMatching(/^shell-inventory:/),
      requestDigest: remoteAgentProcessRequestDigest({
        ...f.input,
        cwd: "/",
        command: "/usr/bin/env",
        environment: [],
        maxOutputBytes: 8192,
      }),
      command: "/usr/bin/env",
      args: f.input.args,
      environment: [],
      timeoutMs: 10000,
      maxOutputBytes: 8192,
      signal: f.controller.signal,
    });
    expect(f.process.cancelAndWait).not.toHaveBeenCalled();
  });

  it("preserves BOM and rejects malformed UTF-8 rather than repairing inventory", async () => {
    const f = fixture();
    f.process.run.mockResolvedValue(output({ stdout: new Uint8Array([0xef, 0xbb, 0xbf, 65]) }));
    expect((await runRemoteAgentShellInventory(f.input, f)).stdout).toBe("﻿A");
    for (const bytes of [[0xff], [0xc3], [0xc0, 0x80]]) {
      f.process.run.mockResolvedValue(output({ stdout: new Uint8Array(bytes) }));
      await expect(runRemoteAgentShellInventory(f.input, f)).rejects.toThrow();
    }
  });

  it.each(["truncated", "replay", "oversized", "combined"])(
    "rejects %s output before decoding",
    async (kind) => {
      const f = fixture();
      const response = output();
      f.process.run.mockResolvedValue(
        output({
          ...(kind === "truncated"
            ? { completed: { ...response.completed, outputTruncated: true } }
            : {}),
          ...(kind === "replay" ? { replayGap: true } : {}),
          ...(kind === "oversized" ? { stdout: new Uint8Array(8193) } : {}),
          ...(kind === "combined"
            ? { stdout: new Uint8Array(8192), stderr: new Uint8Array(1) }
            : {}),
        }),
      );
      await expect(runRemoteAgentShellInventory(f.input, f)).rejects.toThrow("Incomplete");
    },
  );

  it.each(["resolve", "workspace"])(
    "does not dispatch after cancellation during %s setup",
    async (phase) => {
      const f = fixture();
      if (phase === "resolve")
        f.resolve.mockImplementation(async () => {
          f.controller.abort();
          return { process: f.process, openWorkspace: f.openWorkspace };
        });
      else
        f.openWorkspace.mockImplementation(async () => {
          f.controller.abort();
        });
      await expect(runRemoteAgentShellInventory(f.input, f)).rejects.toThrow();
      expect(f.process.run).not.toHaveBeenCalled();
      expect(f.process.cancelAndWait).not.toHaveBeenCalled();
    },
  );

  it("never resolves or dispatches an already aborted request", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(runRemoteAgentShellInventory(f.input, f)).rejects.toThrow();
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "cancels exactly the dispatched operation; cancellation failure=%s",
    async (fails) => {
      const f = fixture();
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      f.process.run.mockImplementation(async () => {
        started();
        return new Promise(() => {});
      });
      if (fails) f.process.cancelAndWait.mockRejectedValue(new Error("unconfirmed"));
      const pending = runRemoteAgentShellInventory(f.input, f);
      const rejected = expect(pending).rejects.toThrow(
        fails ? "could not be confirmed" : "cancelled",
      );
      await ready;
      f.controller.abort();
      await rejected;
      const request = f.process.run.mock.calls[0]![0] as { operationId: string };
      expect(f.process.cancelAndWait).toHaveBeenCalledExactlyOnceWith({
        operationId: request.operationId,
      });
      expect(f.process.run).toHaveBeenCalledOnce();
    },
  );
});
