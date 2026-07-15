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

      yield* sql`DELETE FROM projection_usage_contributions`;
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
        INSERT INTO projection_usage_contributions (
          contribution_id, activity_id, thread_id, turn_id, provider, model, interaction_mode,
          occurred_at,
          used_tokens, input_tokens, cached_input_tokens, output_tokens,
          reasoning_output_tokens, finalized, source_sequence, updated_at
        ) VALUES
          (
            'codex:usage-thread:turn:old', 'usage-old', 'usage-thread', 'old',
            'codex', 'gpt-5-old', 'plan', '2026-03-01T00:00:00.000Z', 50, 50, 0, 0, 0, 1, 1,
            '2026-03-01T00:00:00.000Z'
          ),
          (
            'codex:usage-thread:turn:current', 'usage-current', 'usage-thread', 'current',
            'codex', 'gpt-5-current', 'plan', '2026-03-02T00:00:00.000Z', 100, 60, 20, 30, 10, 1, 2,
            '2026-03-02T00:00:00.000Z'
          ),
          (
            'opencode:usage-thread:item:message-1', 'usage-item', 'usage-thread', 'current',
            'opencode', 'claude-sonnet', 'plan', '2026-03-02T00:00:03.000Z', 200, 0, 0, 2, 0, 1, 5,
            '2026-03-02T00:00:03.000Z'
          )
      `;

      const entries = yield* snapshotQuery.getUsageEntries("2026-03-02T00:00:00.000Z");
      assert.equal(yield* snapshotQuery.getUsageHistoryStatus(), "building");

      assert.deepEqual(entries, [
        {
          contributionId: "codex:usage-thread:turn:current",
          threadId: "usage-thread",
          turnId: "current",
          createdAt: "2026-03-02T00:00:00.000Z",
          provider: "codex",
          model: "gpt-5-current",
          interactionMode: "plan",
          usedTokens: 100,
          inputTokens: 60,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 10,
        },
        {
          contributionId: "opencode:usage-thread:item:message-1",
          threadId: "usage-thread",
          turnId: "current",
          createdAt: "2026-03-02T00:00:03.000Z",
          provider: "opencode",
          model: "claude-sonnet",
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
        SELECT contribution_id
        FROM projection_usage_contributions
        WHERE occurred_at >= '2026-03-02T00:00:00.000Z'
      `) as ReadonlyArray<{ detail: string }>;
      assert.ok(
        queryPlan.some(
          (row) =>
            row.detail.includes("idx_projection_usage_contributions_occurred") &&
            row.detail.includes("occurred_at>"),
        ),
      );

      const allTimeQueryPlan = (yield* sql`
        EXPLAIN QUERY PLAN
        SELECT contribution_id
        FROM projection_usage_contributions
        ORDER BY occurred_at ASC
      `) as ReadonlyArray<{ detail: string }>;
      assert.ok(
        allTimeQueryPlan.some((row) =>
          row.detail.includes("idx_projection_usage_contributions_occurred"),
        ),
      );
    }),
  );
});
