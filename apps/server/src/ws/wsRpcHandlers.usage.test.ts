import { Effect } from "effect";
import type { OrchestrationReadModel } from "@bigbud/contracts/orchestration/orchestration.thread.ts";
import { describe, expect, it } from "vitest";

import type { WsRpcContext } from "./wsRpcContext";
import { makeWsRpcUsageHandlers } from "./wsRpcHandlers.usage.ts";

function makeContext(snapshot: OrchestrationReadModel): WsRpcContext {
  return {
    ...({} as WsRpcContext),
    projectionSnapshotQuery: {
      getSnapshot: () => Effect.succeed(snapshot),
    } as unknown as WsRpcContext["projectionSnapshotQuery"],
  };
}

function makeSnapshot(createdAtValues: ReadonlyArray<string>): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    projects: [],
    threads: [
      {
        id: "thread_usage" as never,
        projectId: "project_usage" as never,
        title: "Usage thread" as never,
        elevatorSummary: null,
        elevatorSummaryMessageCount: 0,
        modelSelection: {
          provider: "codex",
          model: "gpt-5.5",
        },
        runtimeMode: "local",
        interactionMode: "agent",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-31T23:59:59.999Z",
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: createdAtValues.map((createdAt, index) => ({
          id: `event_usage_${index}` as never,
          tone: "info",
          kind: "context-window.updated",
          summary: "Usage updated" as never,
          payload: {
            usedTokens: 100 + index,
            inputTokens: 10,
            outputTokens: 20,
          },
          turnId: null,
          sequence: index,
          createdAt,
        })),
        checkpoints: [],
        session: null,
        watchingThreads: [],
      },
    ],
    updatedAt: "2026-07-31T23:59:59.999Z",
  } as unknown as OrchestrationReadModel;
}

function toHourBucketStart(date: Date) {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours()),
  ).toISOString();
}

describe("wsRpcHandlers.usage", () => {
  it("collapses all-range usage into UTC month buckets", async () => {
    const handlers = makeWsRpcUsageHandlers(
      makeContext(makeSnapshot(["2026-07-08T12:34:56.789Z", "2026-07-21T09:20:00.000Z"])),
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
      makeContext(makeSnapshot([first.toISOString(), second.toISOString()])),
    );

    const summary = await Effect.runPromise(handlers["server.getUsageSummary"]({ range: "24h" }));

    expect(summary.buckets.map((bucket) => bucket.bucketStart)).toEqual(
      [toHourBucketStart(first), toHourBucketStart(second)].toSorted(),
    );
  });
});
