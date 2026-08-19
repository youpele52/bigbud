import { createHash } from "node:crypto";

import { CommandId, EventId, ProjectId } from "@bigbud/contracts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionBaselineRepository } from "../../persistence/Services/ProjectionBaselines.ts";
import { ProjectionBaselineRepositoryLive } from "../../persistence/Layers/ProjectionBaselines.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { insertProjectionThreadParent } from "../../persistence/Layers/ProjectionThread.test.helpers.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { makeProjectionPipelinePrefixedTestLayer } from "./ProjectionPipeline.test.helpers.ts";

const layer = it.layer(
  Layer.fresh(makeProjectionPipelinePrefixedTestLayer("bigbud-projection-baseline-test-")),
);

const baselineRepositoryLayer = it.layer(
  ProjectionBaselineRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("projection baseline compaction", (it) => {
  it.effect(
    "verifies incremental baselines, compacts bounded prefixes, and restores bootstrap",
    () =>
      Effect.gen(function* () {
        const pipeline = yield* OrchestrationProjectionPipeline;
        const eventStore = yield* OrchestrationEventStore;
        const sql = yield* SqlClient.SqlClient;
        const now = new Date().toISOString();
        const projectId = ProjectId.makeUnsafe("project-baseline");

        yield* eventStore.append({
          type: "project.created",
          eventId: EventId.makeUnsafe("event-baseline-created"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe("command-baseline-created"),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            projectId,
            title: "Baseline project",
            workspaceRoot: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* pipeline.bootstrap;
        yield* pipeline.ensureVerifiedBaselineThrough(1);
        yield* pipeline.compactVerifiedPrefix(1);

        const deleted = yield* eventStore.append({
          type: "project.deleted",
          eventId: EventId.makeUnsafe("event-baseline-deleted"),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: CommandId.makeUnsafe("command-baseline-deleted"),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { projectId, deletedAt: now },
        });
        yield* pipeline.projectEvent(deleted);
        yield* pipeline.ensureVerifiedBaselineThrough(2);
        yield* pipeline.compactVerifiedPrefix(1);

        const baselines = yield* sql<{
          readonly sequence: number;
          readonly status: string;
          readonly detail: string | null;
        }>`
        SELECT sequence, verification_status AS status, verification_detail AS detail
        FROM projection_baselines ORDER BY sequence
      `;
        assert.deepEqual(baselines, [{ sequence: 2, status: "verified", detail: null }]);
        const marker = yield* sql<{ readonly covered: number }>`
        SELECT covered_by_baseline_sequence AS covered
        FROM orchestration_deletion_markers
        WHERE entity_kind = 'project' AND entity_id = ${projectId}
      `;
        assert.deepEqual(marker, [{ covered: 2 }]);
        const replay = yield* eventStore.readReplay(0);
        assert.equal(replay.availability, "gap");
        assert.equal(replay.retainedFromSequenceExclusive, 2);

        yield* sql`DELETE FROM projection_state`;
        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, execution_target_id, workspace_root, scripts_json,
          created_at, updated_at
        ) VALUES ('corrupt-project', 'corrupt', 'local', '/tmp', '[]', ${now}, ${now})
      `;
        yield* pipeline.bootstrap;
        const projects = yield* sql<{ readonly projectId: string }>`
        SELECT project_id AS "projectId" FROM projection_projects
      `;
        assert.deepEqual(projects, [{ projectId: "__chats__" }]);
        const cursors = yield* sql<{ readonly sequence: number }>`
        SELECT last_applied_sequence AS sequence FROM projection_state
      `;
        assert.ok(cursors.length > 0);
        assert.ok(cursors.every((cursor) => cursor.sequence === 2));

        yield* sql`DELETE FROM projection_state WHERE projector = 'projection.projects'`;
        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, execution_target_id, workspace_root, scripts_json,
          created_at, updated_at
        ) VALUES ('missing-cursor-corruption', 'corrupt', 'local', '/tmp', '[]', ${now}, ${now})
      `;
        yield* pipeline.bootstrap;
        const repaired = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_projects
        WHERE project_id = 'missing-cursor-corruption'
      `;
        assert.deepEqual(repaired, [{ count: 0 }]);

        yield* sql`
        UPDATE projection_baselines SET payload_json = payload_json || ' '
        WHERE sequence = 2
      `;
        yield* sql`DELETE FROM projection_state`;
        const tamperedBootstrap = yield* Effect.exit(pipeline.bootstrap);
        assert.equal(tamperedBootstrap._tag, "Failure");
      }),
  );
});

baselineRepositoryLayer("ProjectionBaselineRepository", (it) => {
  it.effect("leaves reactor-managed active thread watches intact when restoring", () =>
    Effect.gen(function* () {
      const baselines = yield* ProjectionBaselineRepository;
      const sql = yield* SqlClient.SqlClient;
      const createdAt = "2026-07-30T00:00:00.000Z";

      yield* insertProjectionThreadParent({
        sql,
        threadId: ThreadId.makeUnsafe("watcher-baseline"),
      });
      yield* insertProjectionThreadParent({
        sql,
        threadId: ThreadId.makeUnsafe("watched-baseline"),
      });

      yield* sql`
        INSERT INTO projection_thread_watches (
          watch_id, watcher_thread_id, watched_thread_id, watched_thread_title,
          source_message_id, status, created_at
        ) VALUES (
          'watch-baseline', 'watcher-baseline', 'watched-baseline', 'Watched baseline thread',
          'message-baseline', 'active', ${createdAt}
        )
      `;
      const payload = yield* baselines.capturePayload();
      yield* baselines.restorePayload(payload, 0, []);

      const watches = yield* sql<{
        readonly watcherThreadId: string;
        readonly watchedThreadId: string;
      }>`
        SELECT watcher_thread_id AS "watcherThreadId", watched_thread_id AS "watchedThreadId"
        FROM projection_thread_watches
      `;
      assert.deepEqual(watches, [
        { watcherThreadId: "watcher-baseline", watchedThreadId: "watched-baseline" },
      ]);
    }),
  );

  it.effect("does not reject a candidate after it has become verified", () =>
    Effect.gen(function* () {
      const baselines = yield* ProjectionBaselineRepository;
      const sql = yield* SqlClient.SqlClient;
      const payloadJson = yield* baselines.capturePayload();
      const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
      const createdAt = "2026-08-03T00:00:00.000Z";
      const inserted = yield* sql<{ readonly baselineId: number }>`
        INSERT INTO projection_baselines (
          sequence, format_version, payload_json, payload_hash,
          verification_status, verification_detail, created_at, verified_at
        ) VALUES (0, 1, ${payloadJson}, ${payloadHash}, 'candidate', NULL, ${createdAt}, NULL)
        RETURNING baseline_id AS "baselineId"
      `;
      const baselineId = inserted[0]?.baselineId;
      assert.isNumber(baselineId);

      yield* baselines.markVerified(baselineId as number, 0, createdAt);
      yield* baselines.markRejected(baselineId as number, "stale verification failure");

      const verified = yield* baselines.latestVerified();
      assert.equal(verified._tag, "Some");
      if (verified._tag === "Some") assert.equal(verified.value.baselineId, baselineId);
    }),
  );
});

it.layer(
  Layer.fresh(ProjectionBaselineRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
)("projection baseline candidate reuse", (it) => {
  it.effect("reuses an existing candidate without recapturing projection tables", () =>
    Effect.gen(function* () {
      const baselines = yield* ProjectionBaselineRepository;
      const sql = yield* SqlClient.SqlClient;
      const payloadJson = yield* baselines.capturePayload();
      const payloadHash = createHash("sha256").update(payloadJson).digest("hex");
      yield* sql`
        INSERT INTO projection_baselines (
          sequence, format_version, payload_json, payload_hash,
          verification_status, verification_detail, created_at, verified_at
        ) VALUES (
          0, 1, ${payloadJson}, ${payloadHash}, 'candidate', NULL,
          '2026-08-03T00:00:00.000Z', NULL
        )
      `;
      yield* sql`DROP TABLE projection_usage_contributions`;

      const existing = yield* baselines.createCandidate([]);
      assert.equal(existing._tag, "Some");
    }),
  );
});
