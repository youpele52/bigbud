import { describe, expect, it } from "vitest";

import { analyzeProbeRun } from "./sleep-wake-probe.analyze.ts";
import { detectSleepWindow, makeTraceClock } from "./sleep-wake-probe.clock.ts";
import {
  parseDesktopSignalLine,
  parseJournalSuspendLine,
  parseMarkerLine,
  parsePmsetLine,
  parseTraceLine,
} from "./sleep-wake-probe.parse.ts";
import { formatTableRow, RESULTS_TABLE_HEADER } from "./sleep-wake-probe.report.ts";
import {
  clockAcrossSleep,
  event,
  makeInputs,
  SLEPT_AT,
  START,
  THREAD,
  TURN,
  WOKE_AT,
} from "./sleep-wake-probe.test.fixtures.ts";

describe("sleep window", () => {
  it("separates wall time from monotonic time across a macOS sleep", () => {
    const window = detectSleepWindow(clockAcrossSleep({ countsSleep: false }));
    expect(window).toMatchObject({ sleptAtMs: SLEPT_AT, wokeAtMs: WOKE_AT, darkWakes: 0 });
    expect(window?.wallGapMs).toBe(10 * 60_000);
    expect(window?.monotonicGapMs).toBe(1_000);
  });

  it("merges a dark wake into one sleep", () => {
    const samples = clockAcrossSleep({ countsSleep: false, darkWakeAt: SLEPT_AT + 4 * 60_000 });
    expect(detectSleepWindow(samples)).toMatchObject({
      sleptAtMs: SLEPT_AT,
      wokeAtMs: WOKE_AT,
      darkWakes: 1,
    });
  });

  it("finds no sleep in a steady run", () => {
    const steady = Array.from({ length: 30 }, (_, index) => ({
      wallMs: START + index * 1000,
      monoMs: index * 1000,
    }));
    expect(detectSleepWindow(steady)).toBeNull();
  });
});

describe("trace clock", () => {
  it("adds the sleep drift to spans that started after the sleep", () => {
    const window = detectSleepWindow(clockAcrossSleep({ countsSleep: false }))!;
    // The server's trace clock is 2 s behind wall time before the sleep.
    const clock = makeTraceClock([{ wallMs: START + 5_000, traceMs: START + 3_000 }], window);
    expect(clock.toWall(START + 10_000)).toBe(START + 12_000);
    const afterWakeTrace = SLEPT_AT - 2_000 + 3_000;
    expect(clock.toWall(afterWakeTrace)).toBe(afterWakeTrace + 2_000 + window.wallGapMs - 1_000);
  });

  it("adds nothing when the monotonic clock counts sleep (Windows)", () => {
    const window = detectSleepWindow(clockAcrossSleep({ countsSleep: true }))!;
    const clock = makeTraceClock([{ wallMs: START, traceMs: START }], window);
    expect(clock.toWall(WOKE_AT + 1_000)).toBe(WOKE_AT + 1_000);
  });
});

describe("parsers", () => {
  it("reads a trace span", () => {
    const span = parseTraceLine(
      '{"type":"effect-span","name":"server.stalled","startTimeUnixNano":"1792600651527049042","endTimeUnixNano":"1792600659922810167","attributes":{"stall.duration_ms":8395}}',
    );
    expect(span).toEqual({
      name: "server.stalled",
      startMs: 1792600651527,
      endMs: 1792600659922,
      attributes: { "stall.duration_ms": 8395 },
    });
    expect(parseTraceLine("not json")).toBeNull();
  });

  it("reads desktop, macOS and Linux power lines", () => {
    expect(
      parseDesktopSignalLine(
        "[2026-10-22T09:00:00.000Z] [desktop run=abc123] connectivity signal kind=resume sequence=4",
      ),
    ).toEqual({
      kind: "resume",
      atMs: Date.parse("2026-10-22T09:00:00.000Z"),
      source: "desktop-log",
    });
    expect(
      parsePmsetLine(
        "2026-10-21 23:11:43 +0200 Sleep               \tEntering Sleep state due to 'Clamshell Sleep'",
      ),
    ).toEqual({ kind: "os-sleep", atMs: Date.parse("2026-10-21T21:11:43Z"), source: "os-log" });
    expect(
      parsePmsetLine("2026-10-21 23:11:45 +0200 DarkWake            \tDarkWake from Deep Idle"),
    ).toBeNull();
    // Scheduled wakes are logged a second after `Sleep` and are not wakes.
    expect(
      parsePmsetLine(
        "2026-10-21 23:11:44 +0200 Wake Requests       \t[process=dasd request=SleepService deltaSecs=1046]",
      ),
    ).toBeNull();
    expect(
      parsePmsetLine(
        "2026-10-21 23:11:55 +0200 Wake                \tDarkWake to FullWake from Deep Idle [CDNVA]",
      ),
    ).toMatchObject({ kind: "os-wake" });
    expect(
      parseJournalSuspendLine("2026-10-22T09:00:01.123456+02:00 host kernel: PM: suspend exit"),
    ).toMatchObject({ kind: "os-wake" });
  });

  it("reads marker lines in seconds", () => {
    expect(parseMarkerLine("start 1792600651")).toEqual({ kind: "start", atMs: 1792600651000 });
    expect(parseMarkerLine("noise")).toBeNull();
  });
});

describe("analyzeProbeRun", () => {
  const running = [
    event(1, "thread.turn-start-requested", START + 2_000, {
      modelSelection: { provider: "claudeAgent", model: "haiku" },
    }),
    event(2, "thread.session-set", START + 2_100, {
      session: { status: "running", activeTurnId: TURN, lastError: null },
    }),
    event(3, "thread.message-sent", SLEPT_AT - 3_000, { role: "assistant", text: "Working" }),
  ];

  it("reports a turn that continued after wake, with reconnect timing", () => {
    const row = analyzeProbeRun(
      makeInputs({
        events: [
          ...running,
          event(4, "thread.message-sent", WOKE_AT + 4_000, { role: "assistant", text: "more" }),
          event(5, "thread.session-set", WOKE_AT + 9_000, {
            session: { status: "ready", activeTurnId: null, lastError: null },
          }),
        ],
      }),
    );
    expect(row.threadId).toBe(THREAD);
    expect(row.turnId).toBe(TURN);
    expect(row.provider).toBe("claudeAgent");
    expect(row.turn).toMatchObject({
      outcome: "continued",
      firstProgressAfterWakeMs: 4_000,
      endedAfterWakeMs: 9_000,
    });
    expect(row.sleep).toMatchObject({
      detected: true,
      wallGapMs: 600_000,
      serverClockDriftMs: 599_000,
    });
    expect(row.signals).toMatchObject({ source: "desktop-log", resumeAfterWakeMs: 500 });
    expect(row.reconnect).toMatchObject({
      socketDropped: true,
      reconnectSuccessAfterWakeMs: 3_000,
      oldSocketEndedAfterWakeMs: 2_000,
      heartbeatFailures: 1,
    });
  });

  it("flags provider retries and a tool that ran twice", () => {
    const row = analyzeProbeRun(
      makeInputs({
        scenario: "tool",
        marker: [
          { kind: "start", atMs: START + 3_000 },
          { kind: "start", atMs: WOKE_AT + 6_000 },
          { kind: "done", atMs: WOKE_AT + 126_000 },
        ],
        providerLog: [
          { atMs: WOKE_AT + 2_000, channel: "NTIVE", text: '{"method":"claude/system/api_retry"}' },
        ],
        events: [
          ...running,
          event(4, "thread.session-set", WOKE_AT + 130_000, {
            session: { status: "ready", activeTurnId: null, lastError: null },
          }),
        ],
      }),
    );
    expect(row.turn.outcome).toBe("retried-internally");
    expect(row.tools).toMatchObject({ markerStarts: 2, markerDones: 1, ranTwice: true });
  });

  it("reports errors, hangs and a lid closed too late", () => {
    const errored = analyzeProbeRun(
      makeInputs({
        events: [
          ...running,
          event(4, "thread.session-set", WOKE_AT + 1_000, {
            session: { status: "error", activeTurnId: TURN, lastError: "fetch failed" },
          }),
        ],
      }),
    );
    expect(errored.turn).toMatchObject({ outcome: "errored", lastError: "fetch failed" });

    const hung = analyzeProbeRun(makeInputs({ events: running, finishedAtMs: WOKE_AT + 180_000 }));
    expect(hung.turn.outcome).toBe("hung");

    const early = analyzeProbeRun(
      makeInputs({
        events: [
          ...running,
          event(4, "thread.session-set", SLEPT_AT - 1_000, {
            session: { status: "ready", activeTurnId: null, lastError: null },
          }),
        ],
      }),
    );
    expect(early.turn.outcome).toBe("finished-before-sleep");
    expect(early.notes.join(" ")).toContain("does not count");
  });

  it("counts every remote marker line, whatever the remote clock says", () => {
    const marker = [
      { kind: "start" as const, atMs: START - 3_600_000 },
      { kind: "done" as const, atMs: START - 3_480_000 },
    ];
    const local = analyzeProbeRun(makeInputs({ events: running, scenario: "tool", marker }));
    expect(local.tools).toMatchObject({ markerStarts: 0, ranTwice: false });
    const remote = analyzeProbeRun(
      makeInputs({ events: running, scenario: "tool", marker, topology: "ssh-remote" }),
    );
    expect(remote.tools).toMatchObject({ markerStarts: 1, markerDones: 1, ranTwice: false });
    expect(remote.notes.join(" ")).toContain("fresh file");
  });

  it("reports no-sleep before no-turn, and no-turn only after a sleep", () => {
    const steady = Array.from({ length: 30 }, (_, index) => ({
      wallMs: START + index * 1000,
      monoMs: index * 1000,
    }));
    const dryRun = analyzeProbeRun(makeInputs({ events: [], clock: steady }));
    expect(dryRun.sleep.detected).toBe(false);
    expect(dryRun.turn.outcome).toBe("no-sleep");

    const slept = analyzeProbeRun(makeInputs({ events: [] }));
    expect(slept.turn.outcome).toBe("no-turn");
    expect(slept.notes.join(" ")).toContain("or pass --thread");
    const pinned = makeInputs({ events: [] });
    const wrongThread = analyzeProbeRun({ ...pinned, meta: { ...pinned.meta, threadId: "t-x" } });
    expect(wrongThread.notes.join(" ")).toContain("in thread t-x");
  });

  it("formats a table row with one cell per header column", () => {
    const row = analyzeProbeRun(makeInputs({ events: running }));
    const cells = formatTableRow(row).slice(2, -2).split(" | ");
    expect(cells).toHaveLength(RESULTS_TABLE_HEADER.length);
  });
});
