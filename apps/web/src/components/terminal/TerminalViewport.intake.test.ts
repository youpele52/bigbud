import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TerminalViewportIntake } from "./TerminalViewport.intake";
import { TerminalWriteBatcher } from "./TerminalWriteBatcher";

const lanes: TerminalWriteBatcher[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  lanes.splice(0).forEach((lane) => lane.dispose());
  vi.runAllTimers();
  vi.useRealTimers();
});
function fixture() {
  const callbacks: Array<() => void> = [];
  const terminal = {
    options: { disableStdin: false },
    buffer: { active: { type: "normal" } },
    write: vi.fn((_data, done) => callbacks.push(done)),
  };
  const failure = vi.fn();
  const lane = new TerminalWriteBatcher(failure);
  lanes.push(lane);
  const applied = vi.fn();
  const input = vi.fn();
  const attached = vi.fn();
  const intake = new TerminalViewportIntake(
    terminal as never,
    lane,
    applied,
    input,
    undefined,
    undefined,
    undefined,
    attached,
  );
  const snapshot = {
    threadId: "thread",
    terminalId: "terminal",
    dropPathMode: "posix" as const,
    cwd: "/workspace",
    worktreePath: null,
    status: "running" as const,
    pid: 1,
    history: "history",
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-10T00:00:00.000Z",
  };
  return { terminal, callbacks, lane, failure, applied, attached, intake, snapshot };
}
it("input stays gated across withheld final callback, failure and disposal", async () => {
  const f = fixture();
  const hydrated = f.intake.hydrate(f.snapshot);
  const rejection = expect(hydrated).rejects.toThrow("view disposed");
  vi.runAllTimers();
  expect(f.intake.acceptsInput).toBe(false);
  // Reset + history can coalesce. Withhold that final parser callback entirely.
  expect(f.terminal.write).toHaveBeenCalledOnce();
  expect(f.intake.acceptsInput).toBe(false);
  f.intake.dispose();
  f.lane.dispose();
  await rejection;
  f.callbacks.shift()?.();
  vi.runAllTimers();
  expect(f.intake.acceptsInput).toBe(false);
});
it("bounded hydration exhaustion stays visibly paused instead of silently splicing history", () => {
  const f = fixture();
  f.intake.receive({
    type: "output",
    threadId: "thread",
    terminalId: "terminal",
    data: "x".repeat(600000),
    createdAt: f.snapshot.updatedAt,
  });
  expect(f.failure).toHaveBeenCalledOnce();
  expect(f.lane.isStopped).toBe(true);
  expect(f.intake.acceptsInput).toBe(false);
  f.intake.dispose();
});

it("attaches live without a baseline: no reset, no suffix replay, modes first, input enabled", async () => {
  const f = fixture();
  const state = { settled: false };
  const hydrated = f.intake
    .hydrate({
      ...f.snapshot,
      history: "unsafe suffix",
      historyTruncated: true,
      liveModes: { sequence: "\x1b[?2004h", alternateScreen: true },
    })
    .finally(() => {
      state.settled = true;
    });
  f.intake.receive({
    type: "output",
    threadId: "thread",
    terminalId: "terminal",
    data: "post-cut",
    createdAt: "2026-10-10T00:00:01.000Z",
  });
  for (let round = 0; round < 20 && !state.settled; round++) {
    await vi.advanceTimersByTimeAsync(100);
    f.callbacks.splice(0).forEach((done) => done());
  }
  await hydrated;
  const written = f.terminal.write.mock.calls.map(([data]) => String(data)).join("");
  expect(written).toBe("\x1b[?1049h\x1b[?2004h");
  expect(f.applied).toHaveBeenCalledWith(expect.objectContaining({ data: "post-cut" }));
  expect(f.failure).not.toHaveBeenCalled();
  expect(f.intake.acceptsInput).toBe(true);
  expect(f.attached).toHaveBeenCalledOnce();
  expect(f.attached).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: "thread", terminalId: "terminal" }),
  );
  f.intake.dispose();
});
