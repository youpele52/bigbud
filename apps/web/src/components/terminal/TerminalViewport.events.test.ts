import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalWriteBatcher } from "./TerminalWriteBatcher";
import { makeApplyTerminalEvent } from "./TerminalViewport.events";

function makeTerminal() {
  return {
    write: vi.fn(),
    clear: vi.fn(),
  };
}

describe("makeApplyTerminalEvent", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("batches output events through the write batcher", () => {
    const terminal = makeTerminal();
    const writeBatcher = { write: vi.fn(), flush: vi.fn() } as unknown as TerminalWriteBatcher;
    const applyTerminalEvent = makeApplyTerminalEvent({
      terminalRef: { current: terminal as never },
      hasHandledExitRef: { current: false },
      dropPathModeRef: { current: "posix" },
      writeBatcher,
      clearSelectionAction: vi.fn(),
      handleSessionExited: vi.fn(),
    });

    applyTerminalEvent({
      threadId: "thread-1",
      terminalId: "default",
      createdAt: "2026-04-02T20:00:00.000Z",
      type: "output",
      data: "hello",
    });

    expect(writeBatcher.write).toHaveBeenCalledWith(terminal, "hello");
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it("flushes pending output before writing a snapshot", () => {
    const terminal = makeTerminal();
    const writeBatcher = { write: vi.fn(), flush: vi.fn() } as unknown as TerminalWriteBatcher;
    const applyTerminalEvent = makeApplyTerminalEvent({
      terminalRef: { current: terminal as never },
      hasHandledExitRef: { current: true },
      dropPathModeRef: { current: "posix" },
      writeBatcher,
      clearSelectionAction: vi.fn(),
      handleSessionExited: vi.fn(),
    });

    applyTerminalEvent({
      threadId: "thread-1",
      terminalId: "default",
      createdAt: "2026-04-02T20:00:00.000Z",
      type: "started",
      snapshot: {
        threadId: "thread-1",
        terminalId: "default",
        dropPathMode: "posix",
        cwd: "/tmp/workspace",
        worktreePath: null,
        status: "running",
        pid: 123,
        history: "snapshot-history",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-04-02T20:00:00.000Z",
      },
    });

    expect(writeBatcher.flush).toHaveBeenCalledTimes(1);
    expect(terminal.write.mock.calls).toEqual([["\u001bc"], ["snapshot-history"]]);
  });

  it("flushes pending output before clearing the terminal", () => {
    const terminal = makeTerminal();
    const writeBatcher = { write: vi.fn(), flush: vi.fn() } as unknown as TerminalWriteBatcher;
    const applyTerminalEvent = makeApplyTerminalEvent({
      terminalRef: { current: terminal as never },
      hasHandledExitRef: { current: false },
      dropPathModeRef: { current: "posix" },
      writeBatcher,
      clearSelectionAction: vi.fn(),
      handleSessionExited: vi.fn(),
    });

    applyTerminalEvent({
      threadId: "thread-1",
      terminalId: "default",
      createdAt: "2026-04-02T20:00:00.000Z",
      type: "cleared",
    });

    expect(writeBatcher.flush).toHaveBeenCalledTimes(1);
    expect(terminal.clear).toHaveBeenCalledTimes(1);
    expect(terminal.write).toHaveBeenCalledWith("\u001bc");
  });

  it("flushes pending output before writing error and exit system messages", () => {
    vi.stubGlobal("window", {
      setTimeout: vi.fn(),
    });
    const terminal = makeTerminal();
    const writeBatcher = { write: vi.fn(), flush: vi.fn() } as unknown as TerminalWriteBatcher;
    const applyTerminalEvent = makeApplyTerminalEvent({
      terminalRef: { current: terminal as never },
      hasHandledExitRef: { current: false },
      dropPathModeRef: { current: "posix" },
      writeBatcher,
      clearSelectionAction: vi.fn(),
      handleSessionExited: vi.fn(),
    });

    applyTerminalEvent({
      threadId: "thread-1",
      terminalId: "default",
      createdAt: "2026-04-02T20:00:00.000Z",
      type: "error",
      message: "boom",
    });
    applyTerminalEvent({
      threadId: "thread-1",
      terminalId: "default",
      createdAt: "2026-04-02T20:00:01.000Z",
      type: "exited",
      exitCode: 1,
      exitSignal: null,
    });

    expect(writeBatcher.flush).toHaveBeenCalledTimes(2);
    expect(terminal.write.mock.calls).toEqual([
      ["\r\n[terminal] boom\r\n"],
      ["\r\n[terminal] Process exited (code 1)\r\n"],
    ]);
  });
});
