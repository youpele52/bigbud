import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProjectId, ThreadId } from "@bigbud/contracts";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationProjectionPipeline } from "../../orchestration/Services/ProjectionPipeline.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../startup/config.ts";
import { EntityPurgeLive } from "./EntityPurge.ts";

export const testLayer = EntityPurgeLive.pipe(
  Layer.provideMerge(
    Layer.succeed(OrchestrationProjectionPipeline, {
      bootstrap: Effect.void,
      backfillUsageContributions: Effect.void,
      ensureVerifiedBaselineThrough: () => Effect.void,
      compactVerifiedPrefix: () => Effect.void,
      projectEvent: () => Effect.void,
    }),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bigbud-purge-security-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

export const NOW = "2026-08-04T00:00:00.000Z";

export const seedThread = Effect.fn("seedSecurityThread")(function* (input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly worktreePath?: string | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at
    ) VALUES (${input.projectId}, 'Project', NULL, '{}', ${NOW}, ${NOW})
    ON CONFLICT (project_id) DO NOTHING
  `;
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode,
      interaction_mode, branch, worktree_path, created_at, updated_at,
      deleted_at, deleting_at, pinned_at
    ) VALUES (
      ${input.threadId}, ${input.projectId}, 'Thread', '{"provider":"codex","model":"test"}',
      'full-access', 'default', NULL, ${input.worktreePath ?? null}, ${NOW}, ${NOW}, NULL, NULL, NULL
    )
  `;
});

export const seedMarker = Effect.fn("seedSecurityMarker")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_baselines (
      sequence, format_version, payload_json, payload_hash, verification_status,
      verification_detail, created_at, verified_at
    ) VALUES (1, 1, '{}', 'test', 'verified', NULL, ${NOW}, ${NOW})
    ON CONFLICT (sequence) DO NOTHING
  `;
  yield* sql`
    INSERT INTO orchestration_deletion_markers (
      entity_kind, entity_id, deletion_sequence, deleted_at, covered_by_baseline_sequence
    ) VALUES ('thread', ${threadId}, 1, ${NOW}, 1)
  `;
});

export function attachmentJson(id: string): string {
  return JSON.stringify([
    {
      type: "image",
      id,
      name: "capture.png",
      mimeType: "image/png",
      sizeBytes: 7,
    },
  ]);
}
