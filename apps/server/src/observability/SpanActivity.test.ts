import { describe, expect, it } from "vitest";

import { rankStallSpans, SpanActivityTracker } from "./SpanActivity.ts";

// The stall under test froze the loop from 10_000 to 85_000 ms.
const STALL_FROM = 10_000;
const STALL_TO = 85_000;

describe("rankStallSpans", () => {
  it("lists the span matching the stall window before long-lived and unrelated spans", () => {
    const subscription = {
      name: "ws.rpc.subscribeOrchestrationDomainEvents",
      startedAtMs: 1_000,
      endedAtMs: null,
    };
    const socket = { name: "http.server GET", startedAtMs: 500, endedAtMs: null };
    const unrelatedBefore = { name: "terminal.poll", startedAtMs: 9_700, endedAtMs: 9_750 };
    const shortOverlap = { name: "git.status", startedAtMs: 9_950, endedAtMs: 10_020 };
    const culprit = { name: "ssh.unlock", startedAtMs: 9_990, endedAtMs: 84_990 };

    const ranked = rankStallSpans(
      [subscription, socket, unrelatedBefore, shortOverlap, culprit],
      STALL_FROM,
      STALL_TO,
      8,
    );

    expect(ranked.map((entry) => entry.name)).toEqual([
      "ssh.unlock",
      "git.status",
      "ws.rpc.subscribeOrchestrationDomainEvents",
      "http.server GET",
    ]);
    expect(rankStallSpans([subscription, culprit], STALL_FROM, STALL_TO, 1)).toEqual([culprit]);
  });

  it("prefers the larger overlap among candidate spans", () => {
    const partial = { name: "partial", startedAtMs: 60_000, endedAtMs: 84_000 };
    const covering = { name: "migration.78", startedAtMs: 9_500, endedAtMs: 85_000 };
    expect(
      rankStallSpans([partial, covering], STALL_FROM, STALL_TO, 8).map((entry) => entry.name),
    ).toEqual(["migration.78", "partial"]);
  });
});

describe("SpanActivityTracker", () => {
  it("ranks running and recently ended spans for a stall", () => {
    const tracker = new SpanActivityTracker();
    tracker.started("subscription", "ws.rpc.subscribeServerLifecycle", 100);
    tracker.started("sql", "sql.execute", 9_900);
    tracker.started("before", "finished-before", 200);
    tracker.ended("before", 400);
    tracker.ended("sql", 85_000);
    tracker.started("after", "started-after", 85_100);

    expect(tracker.stallCandidates(STALL_FROM, STALL_TO, 8)).toEqual([
      { name: "sql.execute", startedAtMs: 9_900, endedAtMs: 85_000 },
      { name: "ws.rpc.subscribeServerLifecycle", startedAtMs: 100, endedAtMs: null },
    ]);
  });

  it("bounds both running and ended records", () => {
    const tracker = new SpanActivityTracker(2, 2);
    tracker.started("a", "a", 1);
    tracker.started("b", "b", 2);
    tracker.started("c", "c", 3);
    expect(tracker.stallCandidates(5, 10, 8).map((entry) => entry.name)).toEqual(["b", "a"]);

    tracker.ended("a", 20);
    tracker.ended("b", 20);
    tracker.started("d", "d", 4);
    tracker.ended("d", 20);
    expect(tracker.stallCandidates(5, 10, 8).map((entry) => entry.name)).toEqual(["d", "b"]);
  });
});
