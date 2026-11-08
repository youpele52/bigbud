import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionCatalogQuery } from "../Services/ProjectionCatalogQuery.ts";
import { ProjectionCatalogQueryLive } from "./ProjectionCatalogQuery.ts";

const layer = it.layer(
  ProjectionCatalogQueryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const insertThread = (
  sql: SqlClient.SqlClient,
  row: {
    readonly id: string;
    readonly projectId: string;
    readonly state: string;
    readonly updatedAt: string;
    readonly purpose?: string;
    readonly archivedAt?: string | null;
    readonly snoozeUntil?: string | null;
  },
) => sql`
  INSERT INTO projection_threads (
    thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
    interaction_mode, branch, worktree_path, latest_turn_id, created_at, updated_at,
    archived_at, deleted_at, organization_state, organization_revision,
    organization_changed_at, organization_snooze_id, organization_snooze_until
  ) VALUES (
    ${row.id}, ${row.projectId}, ${row.id}, ${row.purpose ?? "standard"},
    '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default', NULL, NULL, NULL,
    ${row.updatedAt}, ${row.updatedAt}, ${row.archivedAt ?? null}, NULL, ${row.state}, 1,
    '2026-01-01', ${row.snoozeUntil ? `snooze-${row.id}` : null}, ${row.snoozeUntil ?? null}
  )
`;

layer("ProjectionCatalogQuery organization pages", (it) => {
  it.effect("pages one state across projects in displayed order with a stable keyset", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionCatalogQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_threads`;
      for (const row of [
        { id: "later-a", projectId: "project-a", state: "later", updatedAt: "2026-01-03" },
        { id: "later-b", projectId: "__chats__", state: "later", updatedAt: "2026-01-03" },
        { id: "later-c", projectId: "project-b", state: "later", updatedAt: "2026-01-02" },
        { id: "done-a", projectId: "project-a", state: "done", updatedAt: "2026-01-04" },
        { id: "later-deleting", projectId: "project-a", state: "later", updatedAt: "2026-01-05" },
        { id: "later-deleted", projectId: "project-a", state: "later", updatedAt: "2026-01-05" },
        {
          id: "later-archived",
          projectId: "project-a",
          state: "later",
          updatedAt: "2026-01-05",
          archivedAt: "2026-01-05",
        },
        {
          id: "later-side-chat",
          projectId: "project-a",
          state: "later",
          updatedAt: "2026-01-05",
          purpose: "side-chat",
        },
      ]) {
        yield* insertThread(sql, row);
      }
      yield* sql`UPDATE projection_threads SET deleting_at = '2026-01-05' WHERE thread_id = 'later-deleting'`;
      yield* sql`UPDATE projection_threads SET deleted_at = '2026-01-05' WHERE thread_id = 'later-deleted'`;
      yield* sql`
        UPDATE projection_threads
        SET organization_snooze_id = 'snooze-1', organization_snooze_until = '2026-01-06'
        WHERE thread_id = 'later-c'
      `;

      const first = yield* query.getOrganizationThreadSummaries({ state: "later", limit: 2 });
      // No user messages yet: the sort key is creation time, ties broken by thread id descending.
      assert.deepEqual(
        first.threads.map((thread) => thread.id),
        ["later-b", "later-a"],
      );
      assert.equal(first.state, "later");
      assert.equal(first.totalCount, undefined);
      const counted = yield* query.getOrganizationThreadSummaries({
        state: "later",
        limit: 1,
        includeTotalCount: true,
      });
      assert.equal(counted.threads.length, 1);
      assert.equal(counted.totalCount, 3);
      assert.deepEqual(first.nextCursor, {
        updatedAt: "2026-01-03",
        threadId: ThreadId.makeUnsafe("later-a"),
        sortKey: "2026-01-03",
        sortOrder: "updated_at",
      });

      const second = yield* query.getOrganizationThreadSummaries({
        state: "later",
        limit: 2,
        cursor: first.nextCursor,
        includeTotalCount: true,
      });
      assert.deepEqual(
        second.threads.map((thread) => thread.id),
        ["later-c"],
      );
      assert.equal(second.nextCursor, undefined);
      assert.equal(second.totalCount, 3);
      assert.deepEqual(second.threads[0]?.organization, {
        state: "later",
        revision: 1,
        changedAt: "2026-01-01",
        activityAt: "2026-01-01",
        ageProvenance: "pending",
        snooze: { id: "snooze-1", until: "2026-01-06" },
      });

      const present = yield* query.getOrganizationThreadSummaries({
        state: "present",
        includeTotalCount: true,
      });
      assert.deepEqual(present.threads, []);
      assert.equal(present.totalCount, 0);
    }),
  );

  it.effect("uses the display-order organization index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT thread_id FROM projection_threads t
        WHERE t.organization_state = 'later'
          AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.deleting_at IS NULL
          AND t.purpose = 'standard'
        ORDER BY COALESCE(t.latest_user_message_at, t.created_at) DESC, t.thread_id DESC
        LIMIT 21
      `;
      assert.ok(
        plan.some((row) =>
          row.detail.includes("idx_projection_threads_organization_activity_page"),
        ),
        JSON.stringify(plan),
      );
      assert.ok(!plan.some((row) => row.detail.includes("TEMP B-TREE")), JSON.stringify(plan));
      const countPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT COUNT(*) FROM projection_threads t
        WHERE t.organization_state = 'later' AND t.purpose = 'standard'
          AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.deleting_at IS NULL
      `;
      assert.ok(
        countPlan.some((row) =>
          /idx_projection_threads_(active_organization_state|organization_activity_page)/.test(
            row.detail,
          ),
        ),
        JSON.stringify(countPlan),
      );
    }),
  );
});
