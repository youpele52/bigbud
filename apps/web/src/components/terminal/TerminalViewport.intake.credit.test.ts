import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  TerminalEvent,
  TerminalSessionSnapshot,
} from "@bigbud/contracts/workspace/terminal.ts";
import { TerminalViewportIntake } from "./TerminalViewport.intake";
import { TerminalWriteBatcher } from "./TerminalWriteBatcher";

const disposals: Array<() => void> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  disposals.splice(0).forEach((dispose) => dispose());
  vi.runAllTimers();
  vi.useRealTimers();
});

const SNAPSHOT_AT = "2026-10-29T00:00:01.000Z";

function fixture() {
  const parsed: string[] = [];
  const terminal = {
    options: { disableStdin: true },
    write(data: string, done: () => void) {
      parsed.push(data);
      done();
    },
  };
  const lane = new TerminalWriteBatcher(vi.fn());
  const released = vi.fn();
  const intake = new TerminalViewportIntake(
    terminal as never,
    lane,
    (event) => {
      if (event.type === "output") lane.write(terminal as never, event.data, event.data.length);
    },
    () => undefined,
    released,
  );
  const snapshot: TerminalSessionSnapshot = {
    threadId: "thread",
    terminalId: "terminal",
    cwd: "/synthetic",
    worktreePath: null,
    dropPathMode: "posix",
    status: "running",
    pid: 1,
    history: "H".repeat(100_000),
    exitCode: null,
    exitSignal: null,
    updatedAt: SNAPSHOT_AT,
  };
  disposals.push(() => {
    intake.dispose();
    lane.dispose();
  });
  return { intake, lane, released, snapshot, parsed };
}

const output = (data: string, createdAt: string): TerminalEvent => ({
  type: "output",
  threadId: "thread",
  terminalId: "terminal",
  data,
  createdAt,
});

it("counts output parked during hydration as outstanding until it is parsed", async () => {
  const f = fixture();
  const hydration = f.intake.hydrate(f.snapshot);
  f.intake.receive(output("live-after-snapshot", "2026-10-29T00:00:02.000Z"));

  expect(f.intake.pendingOutputChars).toBe("live-after-snapshot".length);
  expect(f.released).not.toHaveBeenCalled();

  await vi.runAllTimersAsync();
  await hydration;

  expect(f.intake.pendingOutputChars).toBe(0);
  expect(f.lane.outstandingCredit).toBe(0);
  expect(f.parsed.join("")).toContain("live-after-snapshot");
});

it("releases credit when a snapshot covers parked output so the stream can acknowledge it", () => {
  const f = fixture();
  f.intake.receive(output("covered-by-snapshot", "2026-10-29T00:00:00.500Z"));
  expect(f.intake.pendingOutputChars).toBe("covered-by-snapshot".length);

  f.intake.receive({
    type: "started",
    threadId: "thread",
    terminalId: "terminal",
    snapshot: f.snapshot,
    createdAt: SNAPSHOT_AT,
  });

  expect(f.intake.pendingOutputChars).toBe(0);
  expect(f.released).toHaveBeenCalledTimes(1);
});

it("does not report released credit when nothing parked was discarded", () => {
  const f = fixture();
  f.intake.receive(output("after", "2026-10-29T00:00:02.000Z"));
  // Disposal at teardown rejects the unfinished hydration.
  f.intake.hydrate(f.snapshot).catch(() => undefined);

  expect(f.released).not.toHaveBeenCalled();
  expect(f.intake.pendingOutputChars).toBe("after".length);
});

it("clears parked credit when the intake pauses", () => {
  const f = fixture();
  f.intake.receive(output("parked", "2026-10-29T00:00:02.000Z"));
  f.intake.pause(new Error("stopped"));

  expect(f.intake.pendingOutputChars).toBe(0);
});
