import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ProjectionUsageEntry } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

import type { WsRpcContext } from "./wsRpcContext";
import { makeWsRpcUsageHandlers } from "./wsRpcHandlers.usage.ts";

function makeContext(entries: ReadonlyArray<ProjectionUsageEntry>): WsRpcContext {
  return {
    ...({} as WsRpcContext),
    projectionSnapshotQuery: {
      getUsageEntries: () => Effect.succeed(entries),
      getUsageHistoryStatus: () => Effect.succeed("ready"),
    } as unknown as WsRpcContext["projectionSnapshotQuery"],
  };
}

function makeEntries(createdAtValues: ReadonlyArray<string>): ReadonlyArray<ProjectionUsageEntry> {
  return createdAtValues.map((createdAt, index) => ({
    contributionId: `codex:thread-1:turn:turn-${index}`,
    threadId: "thread-1",
    turnId: `turn-${index}`,
    createdAt,
    provider: "codex",
    model: "gpt-5.5",
    interactionMode: "agent",
    usedTokens: 100 + index,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 0,
  }));
}

function toHourBucketStart(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()),
  ).toISOString();
}

describe("wsRpcHandlers.usage", () => {
  it("collapses all-range usage into UTC month buckets", async () => {
    const handlers = makeWsRpcUsageHandlers(
      makeContext(makeEntries(["2026-07-08T12:34:56.789Z", "2026-07-21T09:20:00.000Z"])),
    );

    const summary = await Effect.runPromise(handlers["server.getUsageSummary"]({ range: "all" }));

    expect(summary.buckets).toEqual([
      expect.objectContaining({
        bucketStart: "2026-07-01T00:00:00.000Z",
        turnCount: 2,
        usedTokens: 201,
      }),
    ]);
  });

  it("keeps 24h usage bucketed at the hour level", async () => {
    const first = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const second = new Date(Date.now() - 1 * 60 * 60 * 1000);
    const handlers = makeWsRpcUsageHandlers(
      makeContext(makeEntries([first.toISOString(), second.toISOString()])),
    );

    const summary = await Effect.runPromise(handlers["server.getUsageSummary"]({ range: "24h" }));

    expect(summary.buckets.map((bucket) => bucket.bucketStart)).toEqual(
      [toHourBucketStart(first), toHourBucketStart(second)].toSorted(),
    );
  });

  it("sums item contributions while counting their turn once", async () => {
    const createdAt = new Date().toISOString();
    const [entry] = makeEntries([createdAt]);
    if (!entry) throw new Error("Expected usage entry");
    const handlers = makeWsRpcUsageHandlers(
      makeContext([
        { ...entry, contributionId: "opencode:thread-1:item:item-1", usedTokens: 100 },
        { ...entry, contributionId: "opencode:thread-1:item:item-2", usedTokens: 200 },
      ]),
    );

    const summary = await Effect.runPromise(handlers["server.getUsageSummary"]({ range: "24h" }));

    expect(summary.totals).toEqual(expect.objectContaining({ usedTokens: 300, turnCount: 1 }));
    expect(summary.providerCoverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "cursor", status: "unavailable" }),
        expect.objectContaining({ provider: "devin", status: "unavailable" }),
      ]),
    );
  });
});
