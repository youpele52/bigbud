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
  "usage v2 persistence",
  (it) => {
    it.effect(
      "estimates final observable text; late official zero suppresses across date ranges",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const repository = yield* ProjectionThreadActivityRepository;
          const threadId = ThreadId.makeUnsafe("estimate-thread");
          yield* insertProjectionThreadParent({ sql, threadId });
          yield* sql`INSERT INTO projection_turns (thread_id, turn_id, pending_message_id, state, requested_at, started_at, completed_at, checkpoint_files_json,
      usage_provider, usage_model, usage_interaction_mode, usage_attribution_source)
      VALUES (${threadId}, 'turn', 'prompt', 'completed', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:01.000Z', '2026-10-01T00:00:02.000Z', '[]', 'cursor', 'frozen-model', 'default', 'turn-request')`;
          yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('prompt', ${threadId}, NULL, 'user', '😀😀😀😀😀', 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
      ('answer', ${threadId}, 'turn', 'assistant', 'hello', 0, '2026-10-01T00:00:02.000Z', '2026-10-01T00:00:02.000Z')`;
          const query = makeGetUsageEntries(sql);
          assert.equal((yield* query(null)).length, 0);
          yield* runUsageEstimateBackfill(sql);
          const estimated = yield* query(null);
          assert.equal(estimated.length, 1);
          assert.equal(estimated[0]!.usedTokens, 4);
          assert.equal(estimated[0]!.model, "frozen-model");
          assert.equal(estimated[0]!.source, "estimated");
          yield* repository.upsertUsageContribution({
            contributionId: "cursor:estimate-thread:turn:turn",
            activityId: EventId.makeUnsafe("official"),
            threadId,
            turnId: TurnId.makeUnsafe("turn"),
            provider: "cursor",
            model: "actual-model",
            interactionMode: "default",
            occurredAt: "2026-10-15T00:00:00.000Z",
            usedTokens: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            finalized: true,
            sourceSequence: 1,
            updatedAt: "2026-10-15T00:00:00.000Z",
            accounting: canonicalUsage({ basis: "fixture", inputTokens: 0, outputTokens: 0 })!,
          });
          const official = yield* query(null);
          assert.equal(official.length, 1);
          assert.equal(official[0]!.usedTokens, 0);
          assert.equal(official[0]!.createdAt, "2026-10-01T00:00:00.000Z");
          assert.equal((yield* query("2026-10-10T00:00:00.000Z")).length, 0);
        }),
    );
    it.effect("canonical precedence beats newer legacy and preserves occurrence date", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* ProjectionThreadActivityRepository;
        const threadId = ThreadId.makeUnsafe("authority-thread");
        yield* insertProjectionThreadParent({ sql, threadId });
        const row = {
          contributionId: "codex:authority-thread:turn:turn",
          activityId: EventId.makeUnsafe("authority"),
          threadId,
          turnId: TurnId.makeUnsafe("turn"),
          provider: "codex",
          model: "model",
          interactionMode: "default" as const,
          occurredAt: "2026-10-01T00:00:00.000Z",
          usedTokens: 10,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          finalized: true,
          sourceSequence: 10,
          updatedAt: "2026-10-01T00:00:00.000Z",
        };
        yield* repository.upsertUsageContribution(row);
        yield* repository.upsertUsageContribution({
          ...row,
          usedTokens: 5,
          sourceSequence: 1,
          occurredAt: "2026-10-15T00:00:00.000Z",
          accounting: canonicalUsage({ basis: "fixture", inputTokens: 5, outputTokens: 0 })!,
        });
        yield* repository.upsertUsageContribution({ ...row, usedTokens: 999, sourceSequence: 100 });
        const [persisted] = yield* sql<{
          used_tokens: number;
          occurred_at: string;
        }>`SELECT used_tokens, occurred_at FROM projection_usage_contributions WHERE thread_id = ${threadId}`;
        assert.equal(persisted!.used_tokens, 5);
        assert.equal(persisted!.occurred_at, row.occurredAt);
      }),
    );
    it.effect(
      "persists Codex deltas, recovers missing state, retires reverts and deletes state",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const repository = yield* ProjectionThreadActivityRepository;
          const threadId = ThreadId.makeUnsafe("codex-durable");
          yield* insertProjectionThreadParent({ sql, threadId });
          yield* sql`INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, started_at, checkpoint_files_json)
          VALUES (${threadId}, 'turn', 'running', '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z', '[]'),
            (${threadId}, 'old', 'completed', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '[]')`;
          const counter = (count: number) =>
            canonicalUsage({
              basis: "fixture",
              inputTokens: count,
              outputTokens: 0,
              reportedTotal: count,
            })!;
          const contribution = (sequence: number, total: number, last: number) => ({
            contributionId: "codex:codex-durable:turn:turn",
            activityId: EventId.makeUnsafe(`codex-${sequence}`),
            threadId,
            turnId: TurnId.makeUnsafe("turn"),
            provider: "codex",
            model: "model",
            interactionMode: "default" as const,
            occurredAt: "2026-10-01T00:00:00.000Z",
            usedTokens: last,
            inputTokens: last,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            finalized: true,
            sourceSequence: sequence,
            updatedAt: "2026-10-01T00:00:00.000Z",
            codexObservation: {
              nativeThreadId: "native",
              total: counter(total),
              last: counter(last),
            },
          });
          yield* repository.upsertUsageContribution(contribution(1, 100, 10));
          yield* repository.upsertUsageContribution(contribution(2, 120, 20));
          yield* repository.upsertUsageContribution({
            ...contribution(3, 999, 20),
            contributionId: "codex:codex-durable:turn:old",
            turnId: TurnId.makeUnsafe("old"),
          });
          yield* repository.upsertUsageContribution(contribution(3, 120, 20));
          yield* repository.upsertUsageContribution(contribution(3, 110, 10));
          yield* repository.upsertUsageContribution(contribution(4, 5, 5));
          yield* repository.upsertUsageContribution(contribution(5, 12, 7));
          yield* repository.upsertUsageContribution(contribution(6, 130, 10));
          let rows = yield* sql<{
            used_tokens: number;
          }>`SELECT used_tokens FROM projection_usage_contributions WHERE thread_id = ${threadId}`;
          assert.equal(rows[0]!.used_tokens, 40);
          yield* sql`DELETE FROM projection_usage_codex_state WHERE thread_id = ${threadId}`;
          yield* repository.upsertUsageContribution(contribution(6, 200, 15));
          yield* repository.upsertUsageContribution(contribution(7, 205, 5));
          yield* repository.retireUsageTurns!(threadId, ["turn"]);
          const retiredTurns = Array.from({ length: 2000 }, (_, index) => `retired-${index}`);
          yield* repository.retireUsageTurns!(threadId, retiredTurns);
          yield* repository.retireUsageTurns!(threadId, retiredTurns);
          const [guardCount] = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM projection_usage_codex_retired_turns WHERE thread_id = ${threadId}`;
          assert.equal(guardCount!.count, 2001);
          const [checkpoint] = yield* sql<{
            state_json: string;
          }>`SELECT state_json FROM projection_usage_codex_state WHERE thread_id = ${threadId}`;
          assert.isBelow(checkpoint!.state_json.length, 1000);
          const plan = yield* sql<{
            detail: string;
          }>`EXPLAIN QUERY PLAN SELECT 1 FROM projection_usage_codex_retired_turns WHERE thread_id = ${threadId} AND turn_id = 'retired-0'`;
          assert.isTrue(plan.some((step) => step.detail.includes("PRIMARY KEY")));
          yield* repository.upsertUsageContribution({
            ...contribution(8, 999, 794),
            contributionId: "codex:codex-durable:turn:retired-0",
            turnId: TurnId.makeUnsafe("retired-0"),
          });
          yield* repository.upsertUsageContribution(contribution(8, 999, 794));
          rows = yield* sql<{
            used_tokens: number;
          }>`SELECT used_tokens FROM projection_usage_contributions WHERE thread_id = ${threadId}`;
          assert.equal(rows[0]!.used_tokens, 45);
          yield* repository.deleteUsageByThreadId({ threadId });
          assert.equal(
            (yield* sql`SELECT * FROM projection_usage_codex_retired_turns WHERE thread_id = ${threadId}`)
              .length,
            0,
          );
          assert.equal(
            (yield* sql`SELECT * FROM projection_usage_codex_state WHERE thread_id = ${threadId}`)
              .length,
            0,
          );
        }),
    );
  },
);
