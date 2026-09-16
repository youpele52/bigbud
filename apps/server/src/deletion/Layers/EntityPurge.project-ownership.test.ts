import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { EntityPurge } from "../Services/EntityPurge.ts";
import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../startup/config.ts";
import { EntityPurgeLive } from "./EntityPurge.ts";

const testLayer = EntityPurgeLive.pipe(
  Layer.provideMerge(
    Layer.succeed(OrchestrationProjectionPipeline, {
      bootstrap: Effect.void,
      backfillUsageContributions: Effect.void,
      ensureVerifiedBaselineThrough: () => Effect.void,
      compactVerifiedPrefix: () => Effect.void,
      projectEvent: () => Effect.void,
    }),
  ),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-project-ownership-" }),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer)("EntityPurge project ownership", (it) => {
  it.effect("preflights cross-owned schedules before deleting project threads", () =>
    Effect.gen(function* () {
      const purge = yield* EntityPurge;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.makeUnsafe("project-owner");
      const otherProjectId = ProjectId.makeUnsafe("other-owner");
      const threadId = ThreadId.makeUnsafe("owned-thread");
      const now = "2026-09-13T00:00:00.000Z";
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        ) VALUES (${projectId}, 'Project', '/tmp/project-owner', '{}', ${now}, ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, deleted_at
        ) VALUES (
          ${threadId}, ${projectId}, 'Thread', '{"provider":"codex","model":"test"}',
          'full-access', 'default', ${now}, ${now}, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_baselines (
          sequence, format_version, payload_json, payload_hash, verification_status, created_at, verified_at
        ) VALUES (1, 1, '{}', 'test', 'verified', ${now}, ${now})
      `;
      yield* sql`
        INSERT INTO orchestration_deletion_markers (
          entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
        ) VALUES ('project', ${projectId}, 1, ${now}, 1)
      `;
      yield* sql`
        INSERT INTO automation_schedules (
          automation_id, project_id, target_thread_id, title, prompt, cron_expression,
          timezone, created_at, updated_at
        ) VALUES ('shared-schedule', ${otherProjectId}, ${threadId}, 'Shared', 'prompt', '* * * * *',
          'UTC', ${now}, ${now})
      `;

      const result = yield* Effect.exit(purge.run(yield* purge.requestProject(projectId)));

      assert.isTrue(Exit.isFailure(result));
      assert.deepEqual(yield* sql`SELECT thread_id FROM projection_threads`, [
        { thread_id: threadId },
      ]);
      assert.deepEqual(yield* sql`SELECT automation_id FROM automation_schedules`, [
        { automation_id: "shared-schedule" },
      ]);
    }),
  );
});
