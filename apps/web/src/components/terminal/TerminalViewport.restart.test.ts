import type { Terminal } from "@xterm/xterm";
import type { NativeApi } from "@bigbud/contracts";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { TerminalExecutionTargetError } from "@bigbud/contracts/workspace/terminal.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readTerminalLifecycle,
  useTerminalLifecycleStore,
} from "../../stores/terminal/terminalLifecycle.store";
import { forgetTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { makeTerminalRestartAction } from "./TerminalViewport.restart";
import { subscribeTerminalLifecycleRefresh } from "./terminalLifecycle.recovery";

const old: TerminalSessionSnapshot = {
  threadId: "restart-tests",
  terminalId: "test",
  cwd: "/project",
  worktreePath: null,
  dropPathMode: "posix",
  status: "running",
  pid: 10,
  history: "previous diagnostic output",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-10-29T10:00:00Z",
  runtimeGeneration: "old",
};
const fresh: TerminalSessionSnapshot = { ...old, pid: 11, history: "", runtimeGeneration: "fresh" };
function fixture() {
  const restart = vi.fn(async (_input: unknown) => fresh);
  const snapshotRpc = vi.fn(async () => fresh);
  const confirm = vi.fn(async () => true);
  const hydrate = vi.fn(async (_snapshot: unknown): Promise<void> => undefined);
  const pause = vi.fn();
  const delivery = { intake: { hydrate, pause } };
  let snapshot = old;
  const onFailure = vi.fn();
  const prepare = vi.fn(async () => delivery);
  const input = {
    api: {
      terminal: { restart, snapshot: snapshotRpc },
      dialogs: { confirm },
    } as unknown as NativeApi,
    terminal: { cols: 80, rows: 24 } as Terminal,
    readSnapshot: () => snapshot,
    disposed: () => false,
    prepare,
    isCurrent: () => true,
    onSnapshot: (value: TerminalSessionSnapshot) => {
      snapshot = value;
    },
    onFailure,
  };
  const action = makeTerminalRestartAction(
    input as unknown as Parameters<typeof makeTerminalRestartAction>[0],
  );
  return {
    action,
    restart,
    snapshot: snapshotRpc,
    confirm,
    hydrate,
    pause,
    prepare,
    input,
    onFailure,
  };
}
beforeEach(() => useTerminalLifecycleStore.setState({ operations: {} }));
afterEach(() => {
  vi.useRealTimers();
  useTerminalLifecycleStore.setState({ operations: {} });
  forgetTerminalLaunch(old.threadId, old.terminalId);
});

describe("confirmed restart action", () => {
  it("keeps a confirmed restart complete when its renderer rejects hydration", async () => {
    const f = fixture();
    f.hydrate.mockRejectedValueOnce(new Error("Renderer failed"));
    await f.action();
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
    expect(f.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Renderer failed" }),
    );
    expect(f.pause).toHaveBeenCalledOnce();
    const first = f.restart.mock.calls[0]![0] as { operationId: string };
    await f.action();
    expect(f.restart).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedGeneration: "fresh" }),
    );
    expect((f.restart.mock.calls[1]![0] as { operationId: string }).operationId).not.toBe(
      first.operationId,
    );
  });
  it("releases confirmed ownership before a stalled renderer and another failed listener settle", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.hydrate.mockImplementationOnce(() => new Promise<void>(() => undefined));
    const healthy = vi.fn();
    const failed = subscribeTerminalLifecycleRefresh(
      old.threadId,
      old.terminalId,
      () => {
        throw new Error("Other view failed");
      },
      vi.fn(),
    );
    const live = subscribeTerminalLifecycleRefresh(old.threadId, old.terminalId, healthy, healthy);
    try {
      const pending = f.action();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.restart).toHaveBeenCalledOnce();
      expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
      expect(healthy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20_001);
      await pending;
      expect(f.pause).toHaveBeenCalledOnce();
      expect(f.onFailure).toHaveBeenCalledOnce();
      expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
    } finally {
      failed();
      live();
    }
  });
  it.each(["exited", "error"] as const)(
    "recovers a stale refusal from a retained %s session without restarting automatically",
    async (status) => {
      const f = fixture();
      f.restart.mockRejectedValueOnce(
        new TerminalExecutionTargetError({
          threadId: old.threadId,
          terminalId: old.terminalId,
          executionTargetId: "local",
          detail: "Changed",
          reason: "staleGeneration",
        }),
      );
      f.snapshot.mockResolvedValueOnce({ ...fresh, status, pid: null });
      await f.action();
      expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
      expect(f.restart).toHaveBeenCalledOnce();
      await f.action();
      expect(f.restart).toHaveBeenLastCalledWith(
        expect.objectContaining({ expectedGeneration: "fresh" }),
      );
    },
  );
  it("refreshes a stale refusal and requires a fresh confirmed intent against that generation", async () => {
    const f = fixture();
    f.restart.mockRejectedValueOnce(
      new TerminalExecutionTargetError({
        threadId: old.threadId,
        terminalId: old.terminalId,
        executionTargetId: "local",
        detail: "Session changed",
        reason: "staleGeneration",
      }),
    );
    await f.action();
    expect(f.restart).toHaveBeenCalledOnce();
    expect(f.snapshot).toHaveBeenCalledOnce();
    expect(f.hydrate).toHaveBeenCalledExactlyOnceWith(fresh);
    expect(f.pause).not.toHaveBeenCalled();
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
    const first = f.restart.mock.calls[0]![0] as { operationId: string };
    await f.action();
    expect(f.confirm).toHaveBeenCalledTimes(2);
    expect(f.restart).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedGeneration: "fresh" }),
    );
    expect((f.restart.mock.calls[1]![0] as { operationId: string }).operationId).not.toBe(
      first.operationId,
    );
  });
  it("requires confirmation, reserves before awaiting and preserves target and generation", async () => {
    const f = fixture();
    let approve!: (value: boolean) => void;
    f.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    );
    const pending = f.action();
    await f.action();
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(f.restart).not.toHaveBeenCalled();
    expect(readTerminalLifecycle(old.threadId, old.terminalId)?.phase).toBe("stopping");
    approve(true);
    await pending;
    expect(f.restart).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        expectedGeneration: "old",
        operationId: expect.any(String),
        cwd: "/project",
      }),
    );
    expect(f.hydrate).toHaveBeenCalledExactlyOnceWith(fresh);
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
  });
  it("cancellation makes no destructive request", async () => {
    const f = fixture();
    f.confirm.mockResolvedValue(false);
    await f.action();
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
  });
  it("retries an uncertain outcome with identical operation identity and parameters", async () => {
    const f = fixture();
    f.restart.mockRejectedValueOnce(new Error("response lost"));
    await f.action();
    expect(readTerminalLifecycle(old.threadId, old.terminalId)?.phase).toBe("error");
    const first = f.restart.mock.calls[0]![0];
    await f.action();
    expect(f.restart.mock.calls[1]![0]).toEqual(first);
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
  });
  it("does not pause recovered output when an uncertain retry rejects after the original request succeeds", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let confirmOriginal!: (value: TerminalSessionSnapshot) => void;
    let rejectRetry!: (error: Error) => void;
    f.restart.mockImplementationOnce(
      () =>
        new Promise((done) => {
          confirmOriginal = done;
        }),
    );
    const first = f.action();
    await vi.advanceTimersByTimeAsync(20_001);
    await first;
    f.restart.mockImplementationOnce(
      () =>
        new Promise((_done, fail) => {
          rejectRetry = fail;
        }),
    );
    const retry = f.action();
    await vi.advanceTimersByTimeAsync(0);
    confirmOriginal(fresh);
    await vi.advanceTimersByTimeAsync(0);
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
    f.pause.mockClear();
    f.onFailure.mockClear();
    rejectRetry(new Error("Retry response lost"));
    await retry;
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.onFailure).not.toHaveBeenCalled();
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
  });
  it("retains ownership after a deadline and accepts a late confirmed result", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (value: TerminalSessionSnapshot) => void;
    f.restart.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = f.action();
    await vi.advanceTimersByTimeAsync(20_001);
    await pending;
    expect(readTerminalLifecycle(old.threadId, old.terminalId)?.phase).toBe("error");
    resolve(fresh);
    await vi.advanceTimersByTimeAsync(0);
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
  });
  it("a definitive spawn failure permits a new request against the failed generation", async () => {
    const f = fixture();
    f.restart.mockResolvedValueOnce({
      ...fresh,
      status: "error",
      pid: null,
      history: old.history,
    } as typeof fresh);
    await f.action();
    expect(f.onFailure).toHaveBeenCalledOnce();
    expect(f.hydrate).not.toHaveBeenCalled();
    expect(readTerminalLifecycle(old.threadId, old.terminalId)).toBeUndefined();
    const first = f.restart.mock.calls[0]![0] as { operationId: string };
    await f.action();
    expect(f.restart).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedGeneration: "fresh" }),
    );
    expect((f.restart.mock.calls[1]![0] as { operationId: string }).operationId).not.toBe(
      first.operationId,
    );
  });
});
