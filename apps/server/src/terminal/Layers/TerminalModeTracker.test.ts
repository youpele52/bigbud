import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/headless";
import { TerminalModeTracker } from "./TerminalModeTracker";
import { createTerminalSessionState } from "./Manager.session.state";
import { snapshot } from "./Manager.process-lifecycle";

type Core = {
  mouseStateService: { activeEncoding: string };
  coreService: { decPrivateModes: { cursorStyle?: string; colorSchemeUpdates?: boolean } };
};
const core = (terminal: Terminal) => (terminal as unknown as { _core: Core })._core;
const write = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));

/** Everything a live renderer reads from these modes, compared against the pinned xterm. */
function observable(terminal: Terminal) {
  return {
    ...terminal.modes,
    screen: terminal.buffer.active.type,
    encoding: core(terminal).mouseStateService.activeEncoding,
    cursorStyle: core(terminal).coreService.decPrivateModes.cursorStyle,
    colorSchemeUpdates: core(terminal).coreService.decPrivateModes.colorSchemeUpdates,
  };
}

/** Feed `chunks` to xterm and the tracker; a fresh xterm given only the restore must agree. */
async function compare(chunks: string[]) {
  const source = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  const restored = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  const tracker = new TerminalModeTracker();
  try {
    for (const chunk of chunks) {
      tracker.receive(chunk);
      await write(source, chunk);
    }
    const modes = tracker.snapshot();
    await write(restored, (modes.alternateScreen ? "\x1b[?1049h" : "") + modes.sequence);
    const expected = observable(source);
    expect(observable(restored)).toEqual(expected);
    return { ...modes, expected };
  } finally {
    source.dispose();
    restored.dispose();
  }
}

describe("terminal mode tracker", () => {
  it("restores defaults for plain output", async () => {
    const modes = await compare(["hello\r\nworld"]);
    expect(modes.alternateScreen).toBe(false);
  });

  it("mirrors a full-screen TUI's input modes, including split and combined sequences", async () => {
    const modes = await compare([
      "\x1b[?1049h\x1b[?25l\x1b[?1;2004h\x1b[?100",
      "2h\x1b[?1006h\x1b[?1004h\x1b=\x1b[5 q\x1b[?2031h",
      "drawn frame",
    ]);
    expect(modes.alternateScreen).toBe(true);
    expect(modes.expected).toMatchObject({
      screen: "alternate",
      showCursor: false,
      applicationCursorKeysMode: true,
      applicationKeypadMode: true,
      bracketedPasteMode: true,
      mouseTrackingMode: "drag",
      encoding: "SGR",
      sendFocusMode: true,
      cursorStyle: "bar",
      colorSchemeUpdates: true,
    });
  });

  it("follows resets, protocol replacement and leaving the alternate screen", async () => {
    await compare([
      "\x1b[?1049h\x1b[?1003h\x1b[?1016h\x1b[?2004h",
      "\x1b[?1000h\x1b[?1006l\x1b[!p\x1b[?1049l",
    ]);
    await compare(["\x1b[?1049h\x1b[?1002;1006;2004h\x1bc"]);
    await compare(["\x1b[?1;7l", "\x1b[?25l\x1b>"]);
  });

  it("ignores mode-like text inside strings and honours CAN, C0 and C1 controls", async () => {
    await compare([
      "\x1b]0;title \x1b[?1049h\x07after",
      "\x1b]2;x\x1b\\\x1b[?2\r004h",
      "\x1b[?1000\x18h\x9b?1006h\x9d0;t\x9c",
    ]);
  });

  it("re-opens a control sequence split at the snapshot cut", async () => {
    const tracker = new TerminalModeTracker();
    tracker.receive("\x1b[?20");
    const target = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
    try {
      await write(target, tracker.snapshot().sequence + "04hvisible");
      expect(target.modes.bracketedPasteMode).toBe(true);
      expect(target.buffer.active.getLine(0)?.translateToString(true)).toBe("visible");
    } finally {
      target.dispose();
    }
  });

  it("reaches snapshots only when the view has no history baseline", () => {
    const session = createTerminalSessionState({
      threadId: "thread",
      terminalId: "default",
      executionTargetId: "local",
      dropPathMode: "posix",
      cwd: "/",
      worktreePath: null,
      history: "",
      cols: 80,
      rows: 24,
      runtimeEnv: null,
    });
    session.modeTracker = new TerminalModeTracker();
    session.modeTracker.receive("\x1b[?1049h\x1b[?2004h");
    expect(snapshot(session).liveModes).toBeUndefined();
    session.historyTruncated = true;
    expect(snapshot(session).liveModes).toMatchObject({ alternateScreen: true });
    expect(snapshot(session).liveModes?.sequence).toContain("\x1b[?2004h");
  });
});
