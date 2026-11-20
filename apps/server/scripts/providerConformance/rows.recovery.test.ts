import { describe, expect, it } from "vitest";

import { runAgainstMock, statusOf } from "./conformance.test.helpers.ts";
import { checkDuplicate, checkReplay, orderingProblems } from "./rows.recovery.ts";
import type { ReplayedEvent, ReplayPage } from "./session.ts";

const THREAD = "bigbud-conformance-thread-disconnect-replay-1";
let next = 0;
function event(type: string, payload: Record<string, unknown>, sequence?: number): ReplayedEvent {
  next += 1;
  return {
    sequence: sequence ?? next,
    eventId: `event-${next}`,
    type,
    aggregateId: THREAD,
    commandId: null,
    payload: { threadId: THREAD, ...payload },
  };
}
const user = () =>
  event("thread.message-sent", { messageId: "m1", role: "user", text: "hi", streaming: false });
const reply = (text: string) =>
  event("thread.message-sent", { messageId: "a1", role: "assistant", text, streaming: true });
const settled = (outcome = "completed") => event("thread.turn-settled", { turnId: "t1", outcome });
const page = (events: ReplayedEvent[], availability: ReplayPage["availability"] = "available") => ({
  availability,
  events,
});
const replay = (first: ReplayPage, second: ReplayPage = first) =>
  checkReplay({ threadId: THREAD, messageId: "m1", token: "BBCONF-0000ABCD", first, second });

describe("disconnect + replay row logic", () => {
  it("passes a complete, ordered, idempotent replay", () => {
    const events = [user(), reply("1 2 3 "), reply("BBCONF-0000ABCD"), settled()];
    expect(replay(page(events)).status).toBe("pass");
  });

  it("fails duplicated, reordered, gapped or non-idempotent replays", () => {
    const a = user();
    const b = reply("BBCONF-0000ABCD");
    const c = settled();
    expect(replay(page([a, b, b, c])).reason).toContain("replayed twice");
    expect(replay(page([a, c, b])).reason).toContain("not after");
    expect(replay(page([a, b, c], "gap")).reason).toContain("gap");
    expect(replay(page([a, b, c]), page([a, b])).reason).toContain("differ");
  });

  it("fails when the user message, the reply or a single settlement is missing", () => {
    expect(replay(page([reply("BBCONF-0000ABCD"), settled()])).reason).toContain("user message");
    expect(replay(page([user(), reply("no token"), settled()])).reason).toContain("reply missing");
    expect(replay(page([user(), reply("BBCONF-0000ABCD")])).reason).toContain("settled 0 times");
    expect(replay(page([user(), reply("BBCONF-0000ABCD"), settled("failed")])).reason).toContain(
      "settled failed",
    );
  });

  it("orders by sequence and event id", () => {
    expect(orderingProblems([event("x", {}, 5), event("y", {}, 6)])).toEqual([]);
    expect(orderingProblems([event("x", {}, 6), event("y", {}, 6)])).toHaveLength(1);
  });
});

describe("duplicate receipt row logic", () => {
  const good = {
    firstSequence: 12,
    retrySequence: 12,
    outcomeStatus: "accepted",
    outcomeSequence: 12,
    conflictError: "command receipt conflict",
    userMessageCount: 1,
    turnStartRequests: 1,
    settledCount: 1,
  };

  it("passes a deduplicated retry with a refused conflict", () => {
    expect(checkDuplicate(good).status).toBe("pass");
  });

  it.each([
    [{ retrySequence: 13 }, "original receipt"],
    [{ outcomeStatus: "unknown" }, "command outcome"],
    [{ conflictError: null }, "conflicting payload was accepted"],
    [{ userMessageCount: 2 }, "2 user messages"],
    [{ turnStartRequests: 2 }, "2 turn starts"],
    [{ settledCount: 2 }, "2 settled turns"],
  ])("fails on %o", (change, reason) => {
    const outcome = checkDuplicate({ ...good, ...change });
    expect(outcome.status).toBe("fail");
    expect(outcome.reason).toContain(reason);
  });
});

describe("rows detect injected backend faults", () => {
  it.each([
    ["duplicateRunsTwice", "duplicate-receipt"],
    ["replayDuplicatesEvent", "disconnect-replay"],
    ["acceptAnyRevision", "version-rejection"],
    ["ignoreInterrupt", "cancel"],
  ] as const)("%s makes %s fail", async (fault, row) => {
    const { output } = await runAgainstMock({
      faults: { [fault]: true },
      providers: "codex",
      rows: row,
    });
    const provider = row === "version-rejection" ? "backend" : "codex";
    expect(statusOf(output.results, provider, row)).toBe("fail");
  });
});
