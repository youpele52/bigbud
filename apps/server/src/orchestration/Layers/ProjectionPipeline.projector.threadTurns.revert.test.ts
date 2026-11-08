import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { insertProjectionThreadParent } from "../../persistence/Layers/ProjectionThread.test.helpers.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { makeEvent } from "../projector.test.helpers.ts";
import { makeThreadTurnsProjector } from "./ProjectionPipeline.projector.threadTurns.ts";

const DATE = "2026-09-01T12:00:00.000Z";
const threadId = ThreadId.makeUnsafe("revert-usage-thread");

/** Turn rows as migration 157 leaves them, plus one recorded by a turn request. */
const TURNS = [
  { turnId: "backfilled", count: 1, usage: ["codex", "gpt-5", "plan", "backfill"] },
  { turnId: "partial", count: 2, usage: [null, null, "default", null] },
  { turnId: "requested", count: 3, usage: ["claudeAgent", "opus", "default", "turn-request"] },
  { turnId: "removed", count: 4, usage: ["codex", "gpt-5", "plan", "backfill"] },
] as const;

const readUsage = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly turnId: string;
    readonly provider: string | null;
    readonly model: string | null;
    readonly mode: string | null;
    readonly source: string | null;
  }>`
    SELECT turn_id AS "turnId", usage_provider AS provider, usage_model AS model,
      usage_interaction_mode AS mode, usage_attribution_source AS source
    FROM projection_turns WHERE thread_id = ${threadId} ORDER BY turn_id
  `;
  return rows.map((row) => [row.turnId, row.provider, row.model, row.mode, row.source]);
});

it.layer(ProjectionTurnRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)))(
  "thread turns projector revert",
  (it) => {
    it.effect("keeps the stored usage attribution of kept turns, backfilled or partial", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertProjectionThreadParent({ sql, threadId });
        for (const turn of TURNS) {
          const [provider, model, mode, source] = turn.usage;
          yield* sql`INSERT INTO projection_turns
            (thread_id, turn_id, pending_message_id, state, requested_at, started_at,
              completed_at, checkpoint_turn_count, checkpoint_ref, checkpoint_status,
              checkpoint_files_json, usage_provider, usage_model, usage_interaction_mode,
              usage_attribution_source)
            VALUES (${threadId}, ${turn.turnId}, ${`prompt-${turn.turnId}`}, 'completed',
              ${DATE}, ${DATE}, ${DATE}, ${turn.count}, ${`refs/checkpoint/${turn.count}`},
              'ready', '[]', ${provider}, ${model}, ${mode}, ${source})`;
        }
        const projector = makeThreadTurnsProjector({
          projectionTurnRepository: yield* ProjectionTurnRepository,
        });

        yield* projector.apply(
          makeEvent({
            sequence: 1,
            type: "thread.reverted",
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: DATE,
            commandId: "revert",
            payload: { threadId, turnCount: 3 },
          }),
          { prunedThreadRelativePaths: new Map() },
        );

        assert.deepEqual(yield* readUsage, [
          ["backfilled", "codex", "gpt-5", "plan", "backfill"],
          ["partial", null, null, "default", null],
          ["requested", "claudeAgent", "opus", "default", "turn-request"],
        ]);
        // Backfilled attribution is recorded attribution for later turn updates too.
        const repository = yield* ProjectionTurnRepository;
        const kept = yield* repository.listByThreadId({ threadId });
        assert.deepEqual(
          kept.map((turn): ReadonlyArray<unknown> => [turn.turnId, turn.usageAttribution ?? null]),
          [
            ["backfilled", { provider: "codex", model: "gpt-5", interactionMode: "plan" }],
            ["partial", null],
            ["requested", { provider: "claudeAgent", model: "opus", interactionMode: "default" }],
          ],
        );
      }),
    );
  },
);
