import { describe, expect, it, vi } from "vitest";
import { TerminalWriteBatcher } from "./TerminalWriteBatcher";
import { makeApplyTerminalEvent } from "./TerminalViewport.events";

function fixture() {
  const terminal = { write: vi.fn(), clear: vi.fn() };
  const lane = { write: vi.fn(), barrier: vi.fn() } as unknown as TerminalWriteBatcher;
  const replaySnapshot = vi.fn();
  const exited = vi.fn();
  const apply = makeApplyTerminalEvent({
    terminalRef: { current: terminal as never },
    hasHandledExitRef: { current: false },
    dropPathModeRef: { current: "posix" },
    writeBatcher: lane,
    replaySnapshot,
    isDisposed: () => false,
    clearSelectionAction: vi.fn(),
    handleSessionExited: exited,
  });
  const base = {
    threadId: "thread-1",
    terminalId: "default",
    createdAt: "2026-04-02T20:00:00.000Z",
  };
  return { terminal, lane, replaySnapshot, exited, apply, base };
}
describe("makeApplyTerminalEvent", () => {
  it("orders output and notices on the same callback lane", () => {
    const { terminal, lane, apply, base } = fixture();
    apply({ ...base, type: "output", data: "hello" });
    apply({ ...base, type: "error", message: "failure" });
    apply({ ...base, type: "exited", exitCode: 1, exitSignal: null });
    expect(lane.write).toHaveBeenNthCalledWith(1, terminal, "hello", 5);
    expect(lane.write).toHaveBeenNthCalledWith(2, terminal, "\r\n[terminal] failure\r\n");
    expect(lane.write).toHaveBeenNthCalledWith(
      3,
      terminal,
      "\r\n[terminal] Process exited (code 1)\r\n",
    );
    expect(terminal.write).not.toHaveBeenCalled();
  });
  it("clear is an ordered barrier, not a direct writer bypass", () => {
    const { terminal, lane, apply, base } = fixture();
    apply({ ...base, type: "cleared" });
    expect(terminal.clear).not.toHaveBeenCalled();
    expect(lane.barrier).toHaveBeenCalledOnce();
    expect(lane.write).toHaveBeenCalledWith(terminal, "\x1bc");
  });
  it("started snapshots use the gated replay path", () => {
    const { replaySnapshot, apply, base } = fixture();
    const snapshot = {
      threadId: base.threadId,
      terminalId: base.terminalId,
      dropPathMode: "posix" as const,
      cwd: "/workspace",
      worktreePath: null,
      status: "running" as const,
      pid: 1,
      history: "history",
      exitCode: null,
      exitSignal: null,
      updatedAt: base.createdAt,
    };
    apply({ ...base, type: "started", snapshot });
    expect(replaySnapshot).toHaveBeenCalledWith(snapshot);
  });
});
