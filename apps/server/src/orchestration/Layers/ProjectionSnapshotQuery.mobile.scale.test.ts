import { assert } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { projectionSnapshotLayer } from "./ProjectionSnapshotQuery.test.helpers.ts";

const THREAD_COUNT = 20;
const OLD_HISTORY_ROWS = 120;
const fixture = crypto.randomUUID();

projectionSnapshotLayer("ProjectionSnapshotQuery.mobile.scale", (it) => {
  it.effect("keeps decoded mobile rows bounded as unrelated history grows", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const project = `mobile-scale-project-${fixture}`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at
        ) VALUES (
          ${project}, 'Mobile scale', '/tmp/mobile-scale',
          '{"provider":"codex","model":"gpt-5.4"}', '[]',
          '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z'
        )
      `;

      for (let index = 0; index < THREAD_COUNT; index += 1) {
        const thread = `mobile-scale-thread-${fixture}-${index}`;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json,
            branch, worktree_path, latest_turn_id, created_at, updated_at
          ) VALUES (
            ${thread}, ${project}, ${thread},
            '{"provider":"codex","model":"gpt-5.4"}',
            NULL, NULL, NULL, '2026-09-09T00:00:00.000Z',
            '2026-09-09T00:00:00.000Z'
          )
        `;
        yield* sql`
          WITH RECURSIVE numbers(value) AS (
            SELECT 1
            UNION ALL
            SELECT value + 1 FROM numbers WHERE value < ${OLD_HISTORY_ROWS}
          )
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming,
            created_at, updated_at
          )
          SELECT
            ${thread} || '-message-' || value, ${thread}, 'old', 'assistant',
            'old-history-' || value, 0,
            printf('2025-01-01T00:%02d:%02d.000Z', value / 60, value % 60),
            printf('2025-01-01T00:%02d:%02d.000Z', value / 60, value % 60)
          FROM numbers
        `;
        yield* sql`
          WITH RECURSIVE numbers(value) AS (
            SELECT 1
            UNION ALL
            SELECT value + 1 FROM numbers WHERE value < ${OLD_HISTORY_ROWS}
          )
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
          )
          SELECT
            ${thread} || '-activity-' || value, ${thread}, 'old', 'info',
            'tool.progress', 'old-history', '{}',
            printf('2025-01-01T00:%02d:%02d.000Z', value / 60, value % 60)
          FROM numbers
        `;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
          ) VALUES (
            ${thread} || '-approval', ${thread}, NULL, 'info', 'approval.required',
            'approval', '{}', '2026-09-09T00:00:00.000Z'
          )
        `;
      }
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES (${projector}, 42, '2026-09-09T00:01:00.000Z')
        `;
      }

      const baseline = yield* snapshotQuery.getMobileRecoveryBaseline!(null);
      const messageCount = baseline.snapshot.threads.reduce(
        (count, thread) => count + thread.messages.length,
        0,
      );
      const activityCount = baseline.snapshot.threads.reduce(
        (count, thread) => count + thread.activities.length,
        0,
      );

      assert.equal(baseline.snapshot.threads.length, THREAD_COUNT);
      assert.equal(messageCount, THREAD_COUNT * 4);
      assert.equal(activityCount, THREAD_COUNT);
      assert.isTrue(
        baseline.snapshot.threads.every(
          (thread) =>
            thread.messages.every((message) => message.text.startsWith("old-history-")) &&
            thread.activities.every((activity) => activity.kind === "approval.required"),
        ),
      );
    }),
  );
});
