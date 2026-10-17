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
    write: vi.fn((_data, done) => callbacks.push(done)),
  };
  const failure = vi.fn();
  const lane = new TerminalWriteBatcher(failure);
  lanes.push(lane);
  const applied = vi.fn();
  const input = vi.fn();
  const intake = new TerminalViewportIntake(terminal as never, lane, applied, input);
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
  return { terminal, callbacks, lane, failure, applied, intake, snapshot };
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

it("refuses an incomplete baseline before resetting or writing to the emulator", async () => {
  const f = fixture();
  await f.intake.hydrate({ ...f.snapshot, history: "unsafe suffix", historyTruncated: true });
  vi.runAllTimers();
  expect(f.terminal.write).not.toHaveBeenCalled();
  expect(f.failure).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("process is still running") }),
  );
  expect(f.intake.acceptsInput).toBe(false);
  f.intake.dispose();
});
