import type { NativeApi } from "@bigbud/contracts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readTerminalLaunch,
  recordTerminalLaunch,
  forgetTerminalLaunch,
} from "../../lib/terminalLaunchBinding";
import {
  beginTerminalLifecycle,
  readTerminalLifecycle,
  useTerminalLifecycleStore,
} from "../../stores/terminal/terminalLifecycle.store";
import { closeTerminalConfirmed } from "./terminalLifecycle.operations";

const threadId = ThreadId.makeUnsafe("lifecycle-test");
const terminalId = "test-terminal";
const snapshot: TerminalSessionSnapshot = {
  threadId,
  terminalId,
  cwd: "/project",
  worktreePath: null,
  dropPathMode: "posix",
  status: "running",
  pid: 42,
  history: "keep this output",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-10-29T10:00:00Z",
  runtimeGeneration: "old-generation",
};
function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(close = vi.fn(async (): Promise<void> => undefined)) {
  const terminal = { close, clear: vi.fn(), write: vi.fn(), snapshot: vi.fn(async () => snapshot) };
  const onConfirmed = vi.fn();
  return {
    terminal,
    onConfirmed,
    input: { api: { terminal } as unknown as NativeApi, threadId, terminalId, onConfirmed },
  };
}

beforeEach(() => {
  useTerminalLifecycleStore.setState({ operations: {} });
  recordTerminalLaunch(snapshot);
});
afterEach(() => {
  vi.useRealTimers();
  forgetTerminalLaunch(threadId, terminalId);
  useTerminalLifecycleStore.setState({ operations: {} });
});

describe("confirmed close", () => {
  it("refreshes a definitively stale close and requires a new close intent", async () => {
    const stale = new TerminalExecutionTargetError({
      threadId,
      terminalId,
      executionTargetId: "local",
      detail: "Session changed",
      reason: "staleGeneration",
    });
    const f = fixture(vi.fn().mockRejectedValueOnce(stale).mockResolvedValue(undefined));
    f.terminal.snapshot.mockResolvedValue({ ...snapshot, runtimeGeneration: "fresh" });
    await closeTerminalConfirmed(f.input);
    expect(f.onConfirmed).not.toHaveBeenCalled();
    expect(f.terminal.close).toHaveBeenCalledOnce();
    expect(readTerminalLifecycle(threadId, terminalId)).toBeUndefined();
    expect(readTerminalLaunch(threadId, terminalId)?.runtimeGeneration).toBe("fresh");
    await closeTerminalConfirmed(f.input);
    expect(f.terminal.close).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedGeneration: "fresh" }),
    );
    expect(f.onConfirmed).toHaveBeenCalledOnce();
  });
  it("shows Closing until acknowledgement, fences the generation and never clears or types exit", async () => {
    const stopped = deferred<void>();
    const f = fixture(vi.fn(() => stopped.promise));
    const pending = closeTerminalConfirmed(f.input);
    expect(readTerminalLifecycle(threadId, terminalId)?.phase).toBe("closing");
    expect(f.onConfirmed).not.toHaveBeenCalled();
    expect(readTerminalLaunch(threadId, terminalId)).toBeDefined();
    expect(f.terminal.close).toHaveBeenCalledExactlyOnceWith({
      threadId,
      terminalId,
      deleteHistory: true,
      expectedGeneration: "old-generation",
    });
    await closeTerminalConfirmed(f.input);
    expect(f.terminal.close).toHaveBeenCalledTimes(1);
    expect(beginTerminalLifecycle(threadId, terminalId, "restart")).toBeNull();
    stopped.resolve();
    await pending;
    expect(f.onConfirmed).toHaveBeenCalledOnce();
    expect(readTerminalLifecycle(threadId, terminalId)).toBeUndefined();
    expect(readTerminalLaunch(threadId, terminalId)).toBeUndefined();
    expect(f.terminal.clear).not.toHaveBeenCalled();
    expect(f.terminal.write).not.toHaveBeenCalled();
  });
  it("keeps the item and binding recoverable on failure, then retries the same generation", async () => {
    const f = fixture(
      vi.fn().mockRejectedValueOnce(new Error("connection lost")).mockResolvedValue(undefined),
    );
    await closeTerminalConfirmed(f.input);
    expect(readTerminalLifecycle(threadId, terminalId)).toMatchObject({
      phase: "error",
      error: "connection lost",
    });
    expect(f.onConfirmed).not.toHaveBeenCalled();
    expect(readTerminalLaunch(threadId, terminalId)).toBeDefined();
    recordTerminalLaunch({ ...snapshot, runtimeGeneration: "newer-generation" });
    await closeTerminalConfirmed(f.input);
    expect(f.terminal.close).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedGeneration: "old-generation" }),
    );
    expect(f.onConfirmed).toHaveBeenCalledOnce();
    expect(f.terminal.write).not.toHaveBeenCalled();
  });
  it("treats a timeout as uncertainty but accepts a late definitive acknowledgement", async () => {
    vi.useFakeTimers();
    const stopped = deferred<void>();
    const f = fixture(vi.fn(() => stopped.promise));
    const pending = closeTerminalConfirmed(f.input);
    await vi.advanceTimersByTimeAsync(20_001);
    await pending;
    expect(readTerminalLifecycle(threadId, terminalId)?.phase).toBe("error");
    expect(f.onConfirmed).not.toHaveBeenCalled();
    stopped.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.onConfirmed).toHaveBeenCalledOnce();
    expect(readTerminalLifecycle(threadId, terminalId)).toBeUndefined();
  });
  it("does not send a close to an old server that cannot confirm it", async () => {
    const f = fixture();
    delete (f.terminal as { close?: unknown }).close;
    await closeTerminalConfirmed(f.input);
    expect(readTerminalLifecycle(threadId, terminalId)?.error).toContain(
      "does not support confirmed",
    );
    expect(f.onConfirmed).not.toHaveBeenCalled();
    expect(f.terminal.write).not.toHaveBeenCalled();
  });
  it("requests confirmation of absence without opening when no identity is available", async () => {
    const f = fixture();
    forgetTerminalLaunch(threadId, terminalId);
    delete (f.terminal as { snapshot?: unknown }).snapshot;
    await closeTerminalConfirmed(f.input);
    expect(f.terminal.close).toHaveBeenCalledExactlyOnceWith({
      threadId,
      terminalId,
      deleteHistory: true,
      onlyIfNotRunning: true,
    });
    expect(f.onConfirmed).toHaveBeenCalledOnce();
    expect(readTerminalLifecycle(threadId, terminalId)).toBeUndefined();
  });
  it("retains an identity-free pane when absence cannot be confirmed", async () => {
    const f = fixture(vi.fn().mockRejectedValue(new Error("Terminal is still running")));
    forgetTerminalLaunch(threadId, terminalId);
    delete (f.terminal as { snapshot?: unknown }).snapshot;
    await closeTerminalConfirmed(f.input);
    expect(f.onConfirmed).not.toHaveBeenCalled();
    expect(readTerminalLifecycle(threadId, terminalId)?.phase).toBe("error");
    expect(f.terminal.write).not.toHaveBeenCalled();
  });
});
