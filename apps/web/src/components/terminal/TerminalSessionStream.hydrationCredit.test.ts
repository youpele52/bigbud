import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  TerminalEvent,
  TerminalSessionSnapshot,
} from "@bigbud/contracts/workspace/terminal.ts";
import type { TerminalSessionStreamItem } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { TerminalSessionStream } from "./TerminalSessionStream";
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
const snapshot: TerminalSessionSnapshot = {
  threadId: "thread",
  terminalId: "terminal",
  cwd: "/synthetic",
  worktreePath: null,
  dropPathMode: "posix",
  status: "running",
  pid: 1,
  history: "history",
  exitCode: null,
  exitSignal: null,
  updatedAt: SNAPSHOT_AT,
};
const output = (data: string, createdAt: string): TerminalSessionStreamItem => ({
  type: "output",
  threadId: "thread",
  terminalId: "terminal",
  data,
  createdAt,
});

/** A stream, intake and write lane wired as in the view, with xterm parsing held by the test. */
function fixture() {
  const parses: Array<() => void> = [];
  const terminal = {
    options: { disableStdin: true },
    write(_data: string, done: () => void) {
      parses.push(done);
    },
  };
  const listeners: Array<(item: TerminalSessionStreamItem) => void> = [];
  const push = (item: TerminalSessionStreamItem) => listeners.forEach((listener) => listener(item));
  const ackOutput = vi.fn(async (_input: { subscriptionId: string; processedChars: number }) => {});
  const parsed = () => stream.parsed();
  const lane = new TerminalWriteBatcher(vi.fn(), { onParsed: parsed });
  const intake = new TerminalViewportIntake(
    terminal as never,
    lane,
    (event: TerminalEvent) => {
      if (event.type === "output") lane.write(terminal as never, event.data, event.data.length);
    },
    () => undefined,
    parsed,
  );
  const stream = new TerminalSessionStream(
    {
      subscribeSession: (_input, listener) => {
        listeners.push(listener);
        return () => undefined;
      },
      ackOutput,
    },
    { threadId: "thread", terminalId: "terminal" },
    {
      deliver: (event) => intake.receive(event),
      outstanding: () => lane.outstandingCredit + intake.pendingOutputChars,
      resync: () => undefined,
    },
  );
  disposals.push(() => {
    stream.close();
    intake.dispose();
    lane.dispose();
  });
  const parseOnce = async () => {
    parses.splice(0).forEach((done) => done());
    await vi.advanceTimersByTimeAsync(10);
  };
  const parseAll = async () => {
    for (let turn = 0; turn < 32; turn += 1) await parseOnce();
  };
  const acknowledged = () => ackOutput.mock.calls.at(-1)?.[0].processedChars ?? 0;
  push({ type: "subscribed", subscriptionId: "sub-1" });
  return {
    push,
    intake,
    lane,
    parseOnce,
    parseAll,
    acknowledged,
  };
}

it("does not acknowledge output parked during hydration until xterm parses it", async () => {
  const f = fixture();
  const hydration = f.intake.hydrate(snapshot);
  f.push(output("live-output", "2026-10-29T00:00:02.000Z"));
  await vi.advanceTimersByTimeAsync(200);

  expect(f.acknowledged()).toBe(0);

  await f.parseAll();
  await hydration;
  await vi.advanceTimersByTimeAsync(200);

  expect(f.lane.outstandingCredit).toBe(0);
  expect(f.acknowledged()).toBe("live-output".length);
});

it("keeps applied output outstanding until its parse completes", async () => {
  const f = fixture();
  const hydration = f.intake.hydrate(snapshot);
  f.push(output("pending-parse", "2026-10-29T00:00:02.000Z"));
  // Parse the history replay only, until the parked output has moved into the write lane.
  for (let turn = 0; turn < 32 && f.intake.pendingOutputChars > 0; turn += 1) {
    await f.parseOnce();
  }

  expect(f.intake.pendingOutputChars).toBe(0);
  expect(f.lane.outstandingCredit).toBe("pending-parse".length);
  await vi.advanceTimersByTimeAsync(200);
  expect(f.acknowledged()).toBe(0);

  await f.parseAll();
  await hydration;
  await vi.advanceTimersByTimeAsync(200);
  expect(f.acknowledged()).toBe("pending-parse".length);
});

it("acknowledges parked output a snapshot covers, without parsing it", async () => {
  const f = fixture();
  f.push(output("covered", "2026-10-29T00:00:00.500Z"));
  await vi.advanceTimersByTimeAsync(200);
  expect(f.acknowledged()).toBe(0);

  f.push({
    type: "started",
    threadId: "thread",
    terminalId: "terminal",
    createdAt: SNAPSHOT_AT,
    snapshot,
  });
  await vi.advanceTimersByTimeAsync(200);

  expect(f.acknowledged()).toBe("covered".length);
});
