import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EntityPurge } from "../Services/EntityPurge.ts";
import { EntityPurgeLive } from "./EntityPurge.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../startup/config.ts";

const preflightSequences: Array<number> = [];
const testLayer = EntityPurgeLive.pipe(
  Layer.provideMerge(
    Layer.succeed(OrchestrationProjectionPipeline, {
      bootstrap: Effect.void,
      backfillUsageContributions: Effect.void,
      ensureVerifiedBaselineThrough: (sequence) =>
        Effect.sync(() => preflightSequences.push(sequence)),
      compactVerifiedPrefix: () => Effect.void,
      projectEvent: () => Effect.void,
    }),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-purge-preflight-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer)("entity purge baseline preflight", (it) => {
  it.effect("preflights the highest deletion sequence once for the batch", () =>
    Effect.gen(function* () {
      preflightSequences.length = 0;
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-08-03T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES ('preflight-project', 'Project', NULL, '{}', ${now}, ${now})
      `;
      for (const [threadId, sequence] of [
        ["preflight-thread-1", 1],
        ["preflight-thread-2", 7],
      ] as const) {
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, created_at, updated_at,
            deleted_at, deleting_at, pinned_at
          ) VALUES (
            ${threadId}, 'preflight-project', 'Thread', '{"provider":"codex","model":"test"}',
            'full-access', 'default', NULL, NULL, ${now}, ${now}, ${now}, NULL, NULL
          )
        `;
        yield* sql`
          INSERT INTO orchestration_deletion_markers (
            entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
          ) VALUES ('thread', ${threadId}, ${sequence}, ${now}, NULL)
        `;
      }

      yield* purge.auditAndResume(10);
      assert.deepEqual(preflightSequences, [7]);
    }),
  );
});
