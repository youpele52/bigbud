import type { TerminalScreenItem } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  attachTerminalLifecycleDiagnostics,
  readTerminalLifecycleDiagnostics,
  setTerminalLifecycleDiagnosticsEnabled,
} from "./TerminalLifecycleDiagnostics";
import { TerminalViewportIntake } from "./TerminalViewport.intake";
import { TerminalWriteBatcher } from "./TerminalWriteBatcher";

const lanes: TerminalWriteBatcher[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  lanes.splice(0).forEach((lane) => lane.dispose());
  vi.runAllTimers();
  vi.useRealTimers();
  setTerminalLifecycleDiagnosticsEnabled(false);
});

function fixture() {
  const callbacks: Array<() => void> = [];
  const log: string[] = [];
  const terminal = {
    cols: 100,
    rows: 30,
    options: { disableStdin: false },
    buffer: { active: { type: "normal" } },
    write: vi.fn((data: string, done: () => void) => {
      log.push(`${terminal.options.disableStdin ? "closed" : "open"}:${data}`);
      callbacks.push(done);
    }),
    resize: vi.fn((cols: number, rows: number) => {
      log.push(`resize:${cols}x${rows}`);
      terminal.cols = cols;
      terminal.rows = rows;
    }),
  };
  const lane = new TerminalWriteBatcher(vi.fn());
  lanes.push(lane);
  const applied = vi.fn((event: { type: string; data?: string }) => {
    if (event.type === "output") lane.write(terminal as never, event.data!);
  });
  const screenApplied = vi.fn(() => log.push("fit"));
  const intake = new TerminalViewportIntake(
    terminal as never,
    lane,
    applied as never,
    vi.fn(),
    undefined,
    undefined,
    undefined,
    undefined,
    screenApplied,
  );
  const settle = async () => {
    for (let round = 0; round < 30; round++) {
      await vi.advanceTimersByTimeAsync(20);
      callbacks.splice(0).forEach((done) => done());
    }
  };
  return { terminal, log, intake, applied, screenApplied, settle };
}

const screen: TerminalScreenItem = {
  type: "screen",
  threadId: "thread",
  terminalId: "terminal",
  runtimeGeneration: "gen-1",
  throughSequence: "42",
  cols: 80,
  rows: 24,
  ansi: "SCREEN\x1b[6n",
  pendingEscapeTail: "\x1b[",
  scrollbackRows: 0,
  alternateScreen: false,
  fidelity: "full",
  cold: false,
};
const snapshot = {
  threadId: "thread",
  terminalId: "terminal",
  dropPathMode: "posix" as const,
  cwd: "/workspace",
  worktreePath: null,
  status: "running" as const,
  pid: 1,
  history: "HISTORY",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-11-21T10:00:00.000Z",
  runtimeGeneration: "gen-1",
  screenSource: "host" as const,
};
const output = (data: string) => ({
  type: "output" as const,
  threadId: "thread",
  terminalId: "terminal",
  data,
  // Older than the snapshot: screen-backed output is spliced by sequence, never by timestamp.
  createdAt: "2026-11-21T09:00:00.000Z",
});

it("paints the screen at its grid with replies suppressed, then releases queued live output and fits", async () => {
  const f = fixture();
  f.intake.acceptScreen(screen);
  f.intake.receive(output("LIVE\x1b[c"));
  await f.settle();
  expect(f.log).toEqual([
    "closed:\x1bc",
    "resize:80x24",
    "closed:SCREEN\x1b[6n",
    "closed:\x1b[",
    "open:LIVE\x1b[c",
    "fit",
  ]);
  expect(f.intake.acceptsInput).toBe(true);
  expect(f.screenApplied).toHaveBeenCalledExactlyOnceWith(screen);

  // The open response for the covered generation replays nothing over the painted screen.
  await f.intake.hydrate(snapshot);
  await f.settle();
  expect(f.log.join("")).not.toContain("HISTORY");
  f.intake.dispose();
});

it("a restart (new generation) after a screen replays its history normally", async () => {
  const f = fixture();
  f.intake.acceptScreen(screen);
  await f.settle();
  const hydrated = f.intake.hydrate({
    ...snapshot,
    runtimeGeneration: "gen-2",
    updatedAt: "2026-11-21T11:00:00.000Z",
  });
  await f.settle();
  await hydrated;
  expect(f.log.at(-1)).toBe("closed:\x1bcHISTORY");
  f.intake.dispose();
});

it("a trimmed history renders as a tail and is never reported as a full restore", async () => {
  setTerminalLifecycleDiagnosticsEnabled(true);
  const f = fixture();
  const diagnostics = attachTerminalLifecycleDiagnostics({
    terminal: f.terminal as never,
    threadId: "thread",
    terminalId: "terminal",
    now: () => 0,
  });
  const hydrated = f.intake.hydrate({
    ...snapshot,
    screenSource: "history",
    history: "TAIL",
    historyTrimmed: true,
  });
  await f.settle();
  await hydrated;
  expect(f.log).toEqual(["closed:\x1bcTAIL"]);
  const events = readTerminalLifecycleDiagnostics().map((trace) => trace.event);
  expect(events).toContainEqual(expect.objectContaining({ type: "snapshot", trimmed: true }));
  expect(events).toContainEqual({ type: "hydration", state: "trimmed" });
  expect(events).not.toContainEqual({ type: "hydration", state: "ready" });
  diagnostics.dispose();
  f.intake.dispose();
});
