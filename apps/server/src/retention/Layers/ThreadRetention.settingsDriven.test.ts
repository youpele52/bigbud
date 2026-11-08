import type { OrchestrationCommand } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadRetentionRepositoryLive } from "../../persistence/Layers/ThreadRetentionRepository.ts";
import { ThreadRetentionRepository } from "../../persistence/Services/ThreadRetentionRepository.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { ThreadRetention } from "../Services/ThreadRetention.ts";
import {
  resetRetentionTestRows,
  seedRetentionTestThread,
} from "../threadRetention.test.helpers.ts";
import { ThreadRetentionLive } from "./ThreadRetention.ts";

const dispatched: Extract<OrchestrationCommand, { type: "thread.retention-delete" }>[] = [];

/** Stands in for the engine: claims the item like command processing does, then finishes it. */
const orchestrationLayer = Layer.effect(
  OrchestrationEngineService,
  Effect.gen(function* () {
    const repository = yield* ThreadRetentionRepository;
    return {
      dispatch: (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          if (command.type !== "thread.retention-delete") return { sequence: 0 };
          dispatched.push(command);
          const claim = yield* repository.recheckAndClaimItem({
            runId: command.runId,
            threadId: command.threadId,
            expectedLastActivityAt: command.expectedLastActivityAt,
            cutoffAt: command.cutoffAt,
            claimedAt: command.createdAt,
          });
          if (claim.claimed) {
            const steps = [
              ["deletion_requested", "prepared"],
              ["prepared", "purging"],
              ["purging", "completed"],
            ] as const;
            for (const [from, nextStatus] of steps) {
              yield* repository.transitionItem({
                runId: command.runId,
                threadId: command.threadId,
                expectedStatuses: [from],
                nextStatus,
                updatedAt: command.createdAt,
              });
            }
          }
          return { sequence: dispatched.length };
        }).pipe(Effect.orDie),
      getReadModel: () => Effect.succeed({ threads: [] }),
      streamDomainEvents: Stream.empty,
    } as never;
  }),
);

const layer = it.layer(
  ThreadRetentionLive.pipe(
    Layer.provideMerge(orchestrationLayer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(ThreadRetentionRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/**
 * An old root with a recent child, an old standalone thread whose idle provider session is
 * still marked running, and a thread inside the 3-day window.
 */
const seedThreads = Effect.fn("seedSettingsDrivenThreads")(function* () {
  yield* resetRetentionTestRows();
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM thread_retention_policy_authority`;
  yield* sql`DELETE FROM thread_retention_consent_challenges`;
  yield* seedRetentionTestThread("old-root", daysAgo(10));
  yield* seedRetentionTestThread("new-child", daysAgo(1), { parentThreadId: "old-root" });
  yield* seedRetentionTestThread("old-idle", daysAgo(10));
  yield* seedRetentionTestThread("recent", daysAgo(1));
  yield* sql`INSERT INTO provider_session_runtime
    (thread_id, provider_name, adapter_key, status, last_seen_at)
    VALUES ('old-idle', 'codex', 'codex', 'running', ${daysAgo(10)})`;
});

const runScheduled = Effect.fn("runScheduledRetention")(function* (
  selectionMode: "legacy-subtree" | "per-thread",
) {
  dispatched.length = 0;
  const repository = yield* ThreadRetentionRepository;
  yield* repository.setPolicyAuthority({
    policy: "3-days",
    source: "explicit",
    selectionMode,
    ageCriterion: "last-conversation-activity",
    updatedAt: daysAgo(30),
  });
  const retention = yield* ThreadRetention;
  yield* retention.runScheduledOnce;
  const [run] = yield* repository.listRecentRuns(1);
  return { run: run!, authority: Option.getOrThrow(yield* repository.getPolicyAuthority()) };
});

const challengeCount = Effect.fn("retentionChallengeCount")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ count: number }>`
    SELECT COUNT(*) AS count FROM thread_retention_consent_challenges
  `;
  return rows[0]?.count ?? 0;
});

layer("scheduled retention follows the saved settings", (it) => {
  it.effect("a legacy-subtree policy stays subtree and explains the held-back root", () =>
    Effect.gen(function* () {
      yield* seedThreads();
      const { run, authority } = yield* runScheduled("legacy-subtree");

      assert.deepEqual(
        dispatched.map((command) => [String(command.threadId), command.selectionMode]),
        [["old-idle", "legacy-subtree"]],
      );
      assert.equal(run.trigger, "scheduled");
      assert.equal(run.policy, "3-days");
      assert.equal(run.selectionMode, "legacy-subtree");
      assert.equal(run.ageCriterion, "last-conversation-activity");
      assert.equal(run.status, "completed");
      assert.deepEqual(run.exclusionSummary, {
        olderThanCutoffCount: 2,
        exclusionCounts: [{ reason: "blocked_by_descendant", count: 1 }],
      });
      // Nothing switched the stored mode, and no confirmation was asked for.
      assert.equal(authority.selectionMode, "legacy-subtree");
      assert.equal(yield* challengeCount(), 0);
    }),
  );

  it.effect("a per-thread policy deletes each old thread on its own age", () =>
    Effect.gen(function* () {
      yield* seedThreads();
      const { run, authority } = yield* runScheduled("per-thread");

      assert.deepEqual(
        dispatched.map((command) => [String(command.threadId), command.selectionMode]).toSorted(),
        [
          ["old-idle", "per-thread"],
          ["old-root", "per-thread"],
        ],
      );
      assert.equal(run.selectionMode, "per-thread");
      assert.equal(run.status, "completed");
      assert.deepEqual(run.exclusionSummary, { olderThanCutoffCount: 2, exclusionCounts: [] });
      assert.equal(authority.selectionMode, "per-thread");
      assert.equal(yield* challengeCount(), 0);
    }),
  );
});
