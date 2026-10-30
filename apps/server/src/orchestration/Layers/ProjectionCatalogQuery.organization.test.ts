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
    '2026-01-01', ${row.updatedAt}, ${row.archivedAt ?? null}, NULL, ${row.state}, 1,
    '2026-01-01', ${row.snoozeUntil ? `snooze-${row.id}` : null}, ${row.snoozeUntil ?? null}
  )
`;

layer("ProjectionCatalogQuery organization pages", (it) => {
  it.effect("pages one state across projects by recency with a stable keyset", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionCatalogQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_threads`;
      for (const row of [
        { id: "later-a", projectId: "project-a", state: "later", updatedAt: "2026-01-03" },
        { id: "later-b", projectId: "__chats__", state: "later", updatedAt: "2026-01-03" },
        { id: "later-c", projectId: "project-b", state: "later", updatedAt: "2026-01-02" },
        { id: "done-a", projectId: "project-a", state: "done", updatedAt: "2026-01-04" },
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
      yield* sql`
        UPDATE projection_threads
        SET organization_snooze_id = 'snooze-1', organization_snooze_until = '2026-01-06'
        WHERE thread_id = 'later-c'
      `;

      const first = yield* query.getOrganizationThreadSummaries({ state: "later", limit: 2 });
      assert.deepEqual(
        first.threads.map((thread) => thread.id),
        ["later-a", "later-b"],
      );
      assert.equal(first.state, "later");
      assert.deepEqual(first.nextCursor, { updatedAt: "2026-01-03", threadId: "later-b" });

      const second = yield* query.getOrganizationThreadSummaries({
        state: "later",
        limit: 2,
        cursor: first.nextCursor,
      });
      assert.deepEqual(
        second.threads.map((thread) => thread.id),
        ["later-c"],
      );
      assert.equal(second.nextCursor, undefined);
      assert.deepEqual(second.threads[0]?.organization, {
        state: "later",
        revision: 1,
        changedAt: "2026-01-01",
        snooze: { id: "snooze-1", until: "2026-01-06" },
      });

      const present = yield* query.getOrganizationThreadSummaries({ state: "present" });
      assert.deepEqual(present.threads, []);
    }),
  );

  it.effect("uses the active organization index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT thread_id FROM projection_threads t
        WHERE t.organization_state = 'later'
          AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.deleting_at IS NULL
        ORDER BY t.updated_at DESC, t.thread_id ASC
        LIMIT 21
      `;
      assert.ok(
        plan.some((row) => row.detail.includes("idx_projection_threads_active_organization_state")),
        JSON.stringify(plan),
      );
    }),
  );
});
