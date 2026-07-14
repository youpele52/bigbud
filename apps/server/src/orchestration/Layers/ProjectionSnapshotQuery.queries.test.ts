import { ThreadId } from "@bigbud/contracts";
import { assert } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { asProjectId, projectionSnapshotLayer } from "./ProjectionSnapshotQuery.test.helpers.ts";

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          purpose,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-sidecar',
            'project-active',
            'Sidecar',
            'side-chat',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:04.000Z',
            '2026-03-01T00:00:04.000Z',
            NULL,
            NULL
          ),
          (
            'thread-first',
            'project-active',
            'First Thread',
            'standard',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            'standard',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            'standard',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 4,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(firstThreadId._tag, "Some");
        if (firstThreadId._tag === "Some") {
          assert.equal(firstThreadId.value, ThreadId.makeUnsafe("thread-first"));
        }
      }),
  );

  it.effect("reads usage entries without hydrating the full snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_projects`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json, scripts_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'usage-project', 'Usage Project', '/tmp/usage', NULL, '[]',
          '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id, created_at, updated_at,
          archived_at, deleted_at
        ) VALUES (
          'usage-thread', 'usage-project', 'Usage Thread', 'standard',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'plan',
          NULL, NULL, NULL, '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z', NULL, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES
          (
            'usage-old', 'usage-thread', NULL, 'info', 'context-window.updated', 'Old usage',
            '{"usedTokens":50}', 1, '2026-03-01T00:00:00.000Z'
          ),
          (
            'usage-current', 'usage-thread', NULL, 'info', 'context-window.updated', 'Usage',
            '{"usedTokens":100,"inputTokens":60,"cachedInputTokens":20,"outputTokens":30,"reasoningOutputTokens":10}',
            2, '2026-03-02T00:00:00.000Z'
          ),
          (
            'not-usage', 'usage-thread', NULL, 'info', 'tool.completed', 'Tool',
            '{}', 3, '2026-03-02T00:00:01.000Z'
          ),
          (
            'usage-string', 'usage-thread', NULL, 'info', 'context-window.updated', 'Invalid usage',
            '{"usedTokens":"200"}', 4, '2026-03-02T00:00:02.000Z'
          ),
          (
            'usage-normalized', 'usage-thread', NULL, 'info', 'context-window.updated', 'Normalized usage',
            '{"usedTokens":200.9,"inputTokens":-10,"cachedInputTokens":"20","outputTokens":2.9,"reasoningOutputTokens":null}',
            5, '2026-03-02T00:00:03.000Z'
          )
      `;

      const entries = yield* snapshotQuery.getUsageEntries("2026-03-02T00:00:00.000Z");

      assert.deepEqual(entries, [
        {
          createdAt: "2026-03-02T00:00:00.000Z",
          provider: "codex",
          model: "gpt-5-codex",
          interactionMode: "plan",
          usedTokens: 100,
          inputTokens: 60,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 10,
        },
        {
          createdAt: "2026-03-02T00:00:03.000Z",
          provider: "codex",
          model: "gpt-5-codex",
          interactionMode: "plan",
          usedTokens: 200,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningOutputTokens: 0,
        },
      ]);

      const allEntries = yield* snapshotQuery.getUsageEntries(null);
      assert.deepEqual(
        allEntries.map((entry) => entry.usedTokens),
        [50, 100, 200],
      );

      const queryPlan = (yield* sql`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE kind = 'context-window.updated'
          AND created_at >= '2026-03-02T00:00:00.000Z'
      `) as ReadonlyArray<{ detail: string }>;
      assert.ok(
        queryPlan.some(
          (row) =>
            row.detail.includes("idx_projection_thread_activities_kind_created") &&
            row.detail.includes("created_at>"),
        ),
      );

      const allTimeQueryPlan = (yield* sql`
        EXPLAIN QUERY PLAN
        SELECT activity_id
        FROM projection_thread_activities
        WHERE kind = 'context-window.updated'
      `) as ReadonlyArray<{ detail: string }>;
      assert.ok(
        allTimeQueryPlan.some(
          (row) =>
            row.detail.includes("idx_projection_thread_activities_kind_created") &&
            row.detail.includes("kind=?"),
        ),
      );
    }),
  );
});
