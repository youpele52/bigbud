import { EventId, ThreadId, TurnId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProjectionThreadActivityRepositoryLive } from "./ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepository } from "../Services/ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";
import { makeGetUsageEntries } from "../../orchestration/Layers/ProjectionSnapshotQuery.usage.ts";
import { runUsageEstimateBackfill } from "../../orchestration/Layers/ProjectionPipeline.usageEstimateBackfill.ts";
import { canonicalUsage } from "../../provider/Layers/ProviderUsageAccounting.canonical.ts";

it.layer(ProjectionThreadActivityRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "Codex baseline-only accounting",
  (it) => {
    for (const last of [0, 10]) {
      it.effect(
        `replaces a settled estimate with newly available last=${last} at the same cumulative total`,
        () =>
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const repository = yield* ProjectionThreadActivityRepository;
            const threadId = ThreadId.makeUnsafe(`baseline-only-${last}`);
            const prompt = `prompt-${last}`;
            yield* insertProjectionThreadParent({ sql, threadId });
            yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, started_at, checkpoint_files_json)
        VALUES (${threadId}, 'turn', ${prompt}, 'completed', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:01.000Z', '[]')`;
            yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${prompt}, ${threadId}, 'turn', 'user', 'hello', 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
            yield* runUsageEstimateBackfill(sql);
            const count = (value: number) =>
              canonicalUsage({
                basis: "fixture",
                inputTokens: value,
                outputTokens: 0,
                reportedTotal: value,
              })!;
            const row = {
              contributionId: `codex:${threadId}:turn:turn`,
              activityId: EventId.makeUnsafe(`usage-${last}`),
              threadId,
              turnId: TurnId.makeUnsafe("turn"),
              provider: "codex",
              model: "model",
              interactionMode: "default" as const,
              occurredAt: "2026-10-01T00:00:00.000Z",
              updatedAt: "2026-10-01T00:00:00.000Z",
              sourceSequence: 1,
              usedTokens: 0,
              inputTokens: 0,
              outputTokens: 0,
              cachedInputTokens: 0,
              reasoningOutputTokens: 0,
              finalized: true,
              codexObservation: { nativeThreadId: "native", total: count(100) },
            };
            yield* repository.upsertUsageContribution(row);
            yield* repository.upsertUsageContribution({ ...row, sourceSequence: 2 });
            const query = makeGetUsageEntries(sql);
            const estimated = (yield* query(null)).find((entry) => entry.threadId === threadId)!;
            assert.equal(estimated.source, "estimated");
            assert.equal(estimated.usedTokens, 2);
            assert.equal(
              (yield* sql`SELECT 1 FROM projection_usage_contributions WHERE thread_id = ${threadId}`)
                .length,
              0,
            );
            // Each call reloads the persisted checkpoint, as after a server restart.
            const measured = {
              ...row,
              sourceSequence: 3,
              codexObservation: { ...row.codexObservation, last: count(last) },
            };
            yield* repository.upsertUsageContribution(measured);
            yield* repository.upsertUsageContribution({ ...measured, sourceSequence: 4 });
            const official = (yield* query(null)).filter((entry) => entry.threadId === threadId);
            assert.equal(official.length, 1);
            assert.equal(official[0]!.source, "provider-reported");
            assert.equal(official[0]!.usedTokens, last);
            yield* repository.upsertUsageContribution({
              ...measured,
              sourceSequence: 5,
              codexObservation: { nativeThreadId: "native", total: count(105), last: count(5) },
            });
            assert.equal(
              (yield* query(null)).find((entry) => entry.threadId === threadId)!.usedTokens,
              last + 5,
            );
          }),
      );
    }
  },
);
