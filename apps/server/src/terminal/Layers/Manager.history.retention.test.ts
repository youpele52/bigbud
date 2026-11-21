import { describe, expect, it, vi } from "vitest";
import { createTerminalSessionState, resetSessionRuntimeState } from "./Manager.session.state";
import { snapshot } from "./Manager.process-lifecycle";
import { TERMINAL_SEARCH_TAIL_BYTE_LIMIT } from "./Manager.history.searchTail";
import { diffAnsiFidelity, captureScreen, screenText } from "./TerminalScreenFidelity.harness";
import {
  retainTerminalHistory,
  terminalSearchTail,
  TERMINAL_HISTORY_BYTE_LIMIT,
  TERMINAL_HISTORY_CONTROL_BYTE_LIMIT,
} from "./Manager.history.retention";

function session() {
  return createTerminalSessionState({
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
}

const frame = (i: number) => "\x1b[H\x1b[2JPi " + String(i).padStart(4, "0") + "x".repeat(8192);

it("keeps a newline-free redraw stream at its newest home+erase baseline", () => {
  const state = session();
  for (let i = 0; i < 200; i++) {
    retainTerminalHistory(state, frame(i), 5000);
    expect(
      Buffer.byteLength(state.history + state.pendingHistoryControlSequence),
    ).toBeLessThanOrEqual(TERMINAL_HISTORY_BYTE_LIMIT);
    expect(state.historyBytes).toBe(Buffer.byteLength(state.history));
  }
  expect(state.historyTruncated).toBeFalsy();
  expect(Boolean(state.historyTrimmed)).toBe(false);
  expect(state.history.endsWith(frame(199))).toBe(true);
  // The retained baseline starts at a frame's home+erase, after the tracked modes and SGR.
  const start = state.history.indexOf("\x1b[H\x1b[2JPi ");
  const preamble = state.history.slice(0, start);
  expect(preamble.startsWith("\x1b[?1l")).toBe(true);
  expect(preamble.endsWith("\x1b[0m")).toBe(true);
});

it("discards a newline-free stream that has no baseline boundary and stops retaining", () => {
  const state = session();
  retainTerminalHistory(state, "Pi " + "x".repeat(TERMINAL_HISTORY_BYTE_LIMIT), 5000);
  expect(state.historyTruncated).toBe(true);
  expect(state.history).toBe("");
  expect(retainTerminalHistory(state, "later", 5000)).toBe(false);
  expect(state.history).toBe("");
});

it("counts UTF-8 bytes, not UTF-16 characters, without retaining broken Unicode", () => {
  const state = session();
  retainTerminalHistory(state, "😀".repeat(TERMINAL_HISTORY_BYTE_LIMIT / 4), 5000);
  expect(Buffer.byteLength(state.history)).toBe(TERMINAL_HISTORY_BYTE_LIMIT);
  retainTerminalHistory(state, "é", 5000);
  expect(state.history).toBe("");
  expect(state.historyTruncated).toBe(true);
});

it.each(["\x1b]0;", "\x1bP", "\x1b[", "\x9d0;"])(
  "bounds unfinished control carry %j without leaking its suffix",
  (prefix) => {
    const state = session();
    retainTerminalHistory(state, prefix, 5000);
    for (let i = 0; i < 20; i++) retainTerminalHistory(state, "1".repeat(1024), 5000);
    expect(state.historyTruncated).toBe(true);
    expect(state.pendingHistoryControlSequence).toBe("");
    retainTerminalHistory(state, "\x1b\\secret suffix", 5000);
    expect(state.history).toBe("");
  },
);

it("preserves complete split controls and Unicode below the limit", () => {
  const state = session();
  retainTerminalHistory(state, "\x1b[3", 5000);
  retainTerminalHistory(state, "2mPi 😀\x1b[0m", 5000);
  expect(state.history).toBe("\x1b[32mPi 😀\x1b[0m");
  expect(state.pendingHistoryControlSequence).toBe("");
  expect(state.historyTruncated).toBeFalsy();
});

it("includes bounded parser carry in a snapshot cut between control chunks", () => {
  const state = session();
  retainTerminalHistory(state, "prompt\x1b[3", 5000);
  expect(snapshot(state).history).toBe("prompt\x1b[3");
  retainTerminalHistory(state, "2mPi", 5000);
  expect(snapshot(state).history).toBe("prompt\x1b[32mPi");
  expect(state.historyBytes).toBe(Buffer.byteLength(state.history));
  expect(state.pendingHistoryBytes).toBe(0);
});

it("updates retention counters using only new output, then resets counters with the generation", () => {
  const state = session();
  for (let i = 0; i < 4000; i++) retainTerminalHistory(state, "Pi😀\n", 5000);
  expect(state.historyBytes).toBe(Buffer.byteLength("Pi😀\n") * 4000);
  expect(state.historyNewlines).toBe(4000);
  resetSessionRuntimeState(state);
  expect([state.historyBytes, state.historyNewlines, state.pendingHistoryBytes]).toEqual([0, 0, 0]);
});

it("does not rescan the accumulated transcript to measure each new chunk", () => {
  const state = session();
  const measure = vi.spyOn(Buffer, "byteLength");
  try {
    for (let i = 0; i < 1000; i++) retainTerminalHistory(state, "x".repeat(1024), 5000);
    expect(state.historyBytes).toBe(1_024_000);
    expect(
      measure.mock.calls.every(([value]) => typeof value === "string" && value.length <= 1024),
    ).toBe(true);
  } finally {
    measure.mockRestore();
  }
});

it("accounts split surrogate pairs without accumulating UTF-8 overcounts", () => {
  const state = session();
  for (let i = 0; i < 100; i++) {
    retainTerminalHistory(state, "\ud83d", 5000);
    retainTerminalHistory(state, "\ude00", 5000);
  }
  expect(state.history).toBe("😀".repeat(100));
  expect(state.historyBytes).toBe(400);
});

it("includes unfinished control lines in the snapshot retention limit", () => {
  const state = session();
  retainTerminalHistory(state, "\x1b]0;one\ntwo\nthree", 2);
  expect(state.historyTruncated).toBe(true);
  expect(snapshot(state).history).toBe("");
});

it("invalidates the whole baseline rather than cutting inside multiline OSC", () => {
  const state = session();
  retainTerminalHistory(state, "\x1b]0;one\ntwo\nthree\x07", 2);
  expect(state.historyTruncated).toBe(true);
  expect(state.history).toBe("");
});

it("resets retention only on explicit runtime reset", () => {
  const state = session();
  retainTerminalHistory(state, "\x1b]" + "x".repeat(TERMINAL_HISTORY_CONTROL_BYTE_LIMIT), 5000);
  resetSessionRuntimeState(state);
  retainTerminalHistory(state, "fresh", 5000);
  expect(state.history).toBe("fresh");
  expect(state.historyTruncated).toBe(false);
});

const lines = (from: number, to: number, color = (i: number) => 31 + (i % 7)) =>
  Array.from({ length: to - from }, (_, k) => {
    const i = from + k;
    return `\x1b[${color(i)}mline ${i}\x1b[1m bold`;
  }).join("\r\n") + "\r\n";

describe("rolling tail", () => {
  it("cuts at a line boundary with tracked SGR and modes, matching the full stream", async () => {
    const state = session();
    const stream = "\x1b[?2004h\x1b[?1h" + lines(0, 200);
    for (let i = 0; i < stream.length; i += 997)
      retainTerminalHistory(state, stream.slice(i, i + 997), 100);
    expect(state.historyTruncated).toBeFalsy();
    expect(Boolean(state.historyTrimmed)).toBe(true);
    // The snapshot flags the tail so a view never takes it for a full baseline.
    expect(snapshot(state)).toMatchObject({ historyTrimmed: true, history: state.history });
    expect(snapshot(state)).not.toHaveProperty("historyTruncated");
    expect(state.historyNewlines).toBeLessThanOrEqual(100);
    expect(state.historyBytes).toBe(Buffer.byteLength(state.history));
    // The cut never falls inside a control sequence and re-asserts modes and SGR first.
    expect(state.history).toMatch(
      // oxlint-disable-next-line no-control-regex -- The preamble is control sequences.
      /^\x1b\[\?1h[^]*\x1b\[\?2004h[^]*\x1b\[0;3\d;1m\x1b\[3\dmline \d+/,
    );
    const geometry = { cols: 40, rows: 10 };
    const diffs = await diffAnsiFidelity(stream, state.history, geometry, { scrollback: "newest" });
    expect(diffs).toEqual([]);
    // Without the preamble the same suffix loses bold and the input modes.
    const suffix = state.history.slice(state.history.indexOf("\x1b[0;3"));
    const raw = suffix.slice(suffix.indexOf("m") + 1);
    const rawDiffs = await diffAnsiFidelity(stream, raw, geometry, { scrollback: "newest" });
    expect(rawDiffs.some((diff) => diff.area === "mode")).toBe(true);
    expect(rawDiffs.some((diff) => diff.area === "scrollback")).toBe(true);
  });

  it("keeps the alternate screen and an open SGR across a line cut", async () => {
    const state = session();
    const stream = "\x1b[?1049h\x1b[44m" + "row\r\n".repeat(30) + "\x1b[1mtail";
    retainTerminalHistory(state, stream, 20);
    expect(Boolean(state.historyTrimmed)).toBe(true);
    expect(state.history.startsWith("\x1b[?1049h")).toBe(true);
    const restored = await captureScreen(state.history, { cols: 20, rows: 5 });
    expect(restored.alternateScreen).toBe(true);
    expect(screenText(restored.visible).at(-1)).toBe("tail");
    expect(await diffAnsiFidelity(stream, state.history, { cols: 20, rows: 5 })).toEqual([]);
  });

  it.each([
    ["RIS", "\x1bc"],
    ["home then erase", "\x1b[H\x1b[2J"],
    ["erase then home", "\x1b[2J\x1b[1;1H"],
    ["alternate screen", "\x1b[?1049h"],
    ["legacy alternate screen", "\x1b[?47h"],
    ["clear with scrollback erase", "\x1b[H\x1b[2J\x1b[3J"],
    ["scrollback erase before clear", "\x1b[3J\x1b[H\x1b[2J"],
  ])("restarts at the newest %s boundary as a full baseline", async (_name, boundary) => {
    const state = session();
    const before = lines(0, 40);
    const after = "\x1b[?2004hfresh\r\nscreen";
    retainTerminalHistory(state, before, 5000);
    retainTerminalHistory(state, boundary.slice(0, 2), 5000);
    retainTerminalHistory(state, boundary.slice(2) + after, 5000);
    retainTerminalHistory(state, "\r\n".repeat(40), 60);
    expect(state.historyTruncated).toBeFalsy();
    expect(Boolean(state.historyTrimmed)).toBe(false);
    // The newest boundary of a cluster may be its last control; the screen is the same.
    expect(state.history).toContain(after);
    expect(state.history).not.toContain("line 0");
    const geometry = { cols: 30, rows: 8 };
    const full = before + boundary + after + "\r\n".repeat(40);
    expect(await diffAnsiFidelity(full, state.history, geometry, { scrollback: "none" })).toEqual(
      [],
    );
  });

  it("does not take a lone scrollback erase for a baseline, since the screen survives it", () => {
    const state = session();
    retainTerminalHistory(state, "on screen\r\n\x1b[3Jafter\r\n" + "x\r\n".repeat(20), 10);
    expect(Boolean(state.historyTrimmed)).toBe(true);
  });

  it("never takes control-like text inside an OSC payload for a boundary", () => {
    const state = session();
    retainTerminalHistory(state, "keep\r\n\x1b]0;\x1b[H\x1b[2J\x07" + "x\r\n".repeat(30), 20);
    expect(Boolean(state.historyTrimmed)).toBe(true);
    expect(state.history).not.toContain("\x1b]0;");
  });

  it("discards rather than cut inside a multi-line string control", () => {
    const state = session();
    retainTerminalHistory(state, "a\nb\n\x1bP" + "q\n".repeat(30) + "\x1b\\", 10);
    expect(state.historyTruncated).toBe(true);
    expect(state.history).toBe("");
  });

  it("amortizes trimming over output instead of cutting every chunk", () => {
    const state = session();
    let cuts = 0;
    let previousHead = "";
    for (let i = 0; i < 20_000; i++) {
      retainTerminalHistory(state, `output line ${i} ${"y".repeat(100)}\n`, 5000);
      const head = state.history.slice(0, 120);
      if (head !== previousHead) cuts++;
      previousHead = head;
    }
    expect(state.historyNewlines).toBeLessThanOrEqual(5000);
    expect(cuts).toBeLessThan(20);
  });

  it("keeps a visible-text search tail of at most 512 KiB that survives a lost baseline", () => {
    const state = session();
    for (let i = 0; i < 8000; i++)
      retainTerminalHistory(state, `\x1b[32mmatch ${i}\x1b[0m ${"z".repeat(100)}\r\n`, 5000);
    const tail = terminalSearchTail(state);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(TERMINAL_SEARCH_TAIL_BYTE_LIMIT);
    expect(tail).not.toContain("\x1b");
    expect(tail.startsWith("match ")).toBe(true);
    expect(tail).toContain("match 7999 ");
    retainTerminalHistory(state, "\x1b]0;" + "t".repeat(TERMINAL_HISTORY_CONTROL_BYTE_LIMIT), 5000);
    expect(state.historyTruncated).toBe(true);
    retainTerminalHistory(state, "\x1b[31mafter \x1b]0;ti", 5000);
    retainTerminalHistory(state, "tle\x07loss\r\n", 5000);
    expect(terminalSearchTail(state).endsWith("after loss\r\n")).toBe(true);
  });
});
