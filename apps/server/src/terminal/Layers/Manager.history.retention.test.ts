import { expect, it, vi } from "vitest";
import { createTerminalSessionState, resetSessionRuntimeState } from "./Manager.session.state";
import { snapshot } from "./Manager.process-lifecycle";
import {
  retainTerminalHistory,
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

it("bounds newline-free redraw history and stops retaining after exhaustion", () => {
  const state = session();
  const redraw = "\x1b[H\x1b[2JPi " + "x".repeat(8192);
  for (let i = 0; i < 200; i++) {
    retainTerminalHistory(state, redraw, 5000);
    expect(
      Buffer.byteLength(state.history + state.pendingHistoryControlSequence),
    ).toBeLessThanOrEqual(TERMINAL_HISTORY_BYTE_LIMIT);
  }
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
