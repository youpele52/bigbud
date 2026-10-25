import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { TerminalViewportIntake } from "./TerminalViewport.intake";
import { TerminalWriteBatcher } from "./TerminalWriteBatcher";

const disposals: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose());
  vi.runAllTimers();
  vi.useRealTimers();
});
function fixture() {
  const parsed: string[] = [];
  const terminal = {
    options: { disableStdin: true },
    write(data: string, done: () => void) {
      parsed.push(data);
      done();
    },
  };
  const failure = vi.fn();
  const lane = new TerminalWriteBatcher(failure);
  const intake = new TerminalViewportIntake(
    terminal as never,
    lane,
    (event) => {
      if (event.type === "output") lane.write(terminal as never, event.data);
    },
    () => undefined,
  );
  const snapshot: TerminalSessionSnapshot = {
    threadId: "thread",
    terminalId: "terminal",
    cwd: "/synthetic",
    worktreePath: null,
    dropPathMode: "posix",
    status: "running",
    pid: 1,
    history: "H".repeat(600_000),
    exitCode: null,
    exitSignal: null,
    updatedAt: "2026-10-11T00:00:00.000Z",
  };
  disposals.push(() => {
    intake.dispose();
    lane.dispose();
  });
  return { intake, lane, failure, snapshot, parsed };
}

it("accepts the production started-before-open duplicate history without charging it as live output", async () => {
  const f = fixture();
  f.intake.receive({
    type: "started",
    threadId: "thread",
    terminalId: "terminal",
    snapshot: f.snapshot,
    createdAt: f.snapshot.updatedAt,
  });
  expect(f.failure).not.toHaveBeenCalled();
  const hydration = f.intake.hydrate(f.snapshot);
  await vi.runAllTimersAsync();
  await hydration;
  expect(f.parsed.join("")).toBe("\x1bc" + f.snapshot.history);
  expect(f.intake.acceptsInput).toBe(true);
});

it("filters covered events while replay is running, not only after replay finishes", async () => {
  const f = fixture();
  const hydration = f.intake.hydrate(f.snapshot);
  for (let i = 0; i < 100; i++)
    f.intake.receive({
      type: "output",
      threadId: "thread",
      terminalId: "terminal",
      data: "covered".repeat(1000),
      createdAt: f.snapshot.updatedAt,
    });
  expect(f.failure).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  await hydration;
  expect(f.parsed.join("")).toBe("\x1bc" + f.snapshot.history);
});

it("streams a large restarted history and preserves every post-snapshot byte", async () => {
  const f = fixture();
  const first = f.intake.hydrate({ ...f.snapshot, history: "initial" });
  await vi.runAllTimersAsync();
  await first;
  f.intake.replay({ ...f.snapshot, updatedAt: "2026-10-11T00:00:01.000Z" });
  for (let i = 0; i < 1000; i++)
    f.intake.receive({
      type: "output",
      threadId: "thread",
      terminalId: "terminal",
      data: `N${i}\n`,
      createdAt: "2026-10-11T00:00:02.000Z",
    });
  await vi.runAllTimersAsync();
  expect(f.failure).not.toHaveBeenCalled();
  expect(f.intake.acceptsInput).toBe(true);
  expect(f.parsed.join("")).toBe(
    "\x1bcinitial\x1bc" +
      f.snapshot.history +
      Array.from({ length: 1000 }, (_, i) => `N${i}\n`).join(""),
  );
});

it("serializes overlapping hydration and replaces only bytes covered by a newer snapshot", async () => {
  const f = fixture();
  const first = f.intake.hydrate(f.snapshot);
  const newer = { ...f.snapshot, history: "NEW", updatedAt: "2026-10-11T00:00:02.000Z" };
  f.intake.receive({
    type: "output",
    threadId: "thread",
    terminalId: "terminal",
    data: "covered-by-new-baseline",
    createdAt: "2026-10-11T00:00:01.000Z",
  });
  const second = f.intake.hydrate(newer);
  expect(second).toBe(first);
  f.intake.receive({
    type: "output",
    threadId: "thread",
    terminalId: "terminal",
    data: "TAIL",
    createdAt: "2026-10-11T00:00:03.000Z",
  });
  await vi.runAllTimersAsync();
  await second;
  expect(f.failure).not.toHaveBeenCalled();
  expect(f.parsed.join("").endsWith("\x1bcNEWTAIL")).toBe(true);
  expect(f.parsed.join("")).not.toContain("covered-by-new-baseline");
  expect(f.intake.acceptsInput).toBe(true);
});
