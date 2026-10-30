import { ThreadId } from "@bigbud/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeListPendingThreadSnoozes } from "../Layers/ProjectionThreads.organization.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("143_ProjectionThreadSnoozeIndex", (it) => {
  it.effect("pages pending snoozes of live threads by deadline through the partial index", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 143 });
      const insert = (
        threadId: string,
        snooze: { readonly id: string; readonly until: string } | null,
        lifecycle: { readonly archivedAt?: string; readonly deletingAt?: string } = {},
      ) => sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode, branch,
          worktree_path, latest_turn_id, created_at, updated_at, deleted_at, archived_at,
          deleting_at, organization_state, organization_snooze_id, organization_snooze_until
        ) VALUES (
          ${threadId}, 'project', ${threadId}, '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access', NULL, NULL, NULL, '2026-10-30T00:00:00.000Z',
          '2026-10-30T00:00:00.000Z', NULL, ${lifecycle.archivedAt ?? null},
          ${lifecycle.deletingAt ?? null}, ${snooze ? "later" : "present"},
          ${snooze?.id ?? null}, ${snooze?.until ?? null}
        )
      `;
      yield* insert("b-late", { id: "s-late", until: "2026-10-30T02:00:00.000Z" });
      yield* insert("c-early", { id: "s-c", until: "2026-10-30T01:00:00.000Z" });
      yield* insert("a-early", { id: "s-a", until: "2026-10-30T01:00:00.000Z" });
      yield* insert("unsnoozed", null);
      yield* insert(
        "archived",
        { id: "s-archived", until: "2026-10-30T00:30:00.000Z" },
        {
          archivedAt: "2026-10-30T00:10:00.000Z",
        },
      );
      yield* insert(
        "deleting",
        { id: "s-deleting", until: "2026-10-30T00:30:00.000Z" },
        {
          deletingAt: "2026-10-30T00:10:00.000Z",
        },
      );

      const list = makeListPendingThreadSnoozes(sql);
      const first = yield* list({ limit: 2 });
      assert.deepStrictEqual(
        first.map((row) => row.threadId),
        ["a-early", "c-early"],
      );
      const last = first.at(-1)!;
      const second = yield* list({
        limit: 2,
        after: { until: last.until, threadId: ThreadId.makeUnsafe(last.threadId) },
      });
      assert.deepStrictEqual(second, [
        {
          threadId: ThreadId.makeUnsafe("b-late"),
          snoozeId: "s-late",
          until: "2026-10-30T02:00:00.000Z",
        },
      ]);

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT thread_id FROM projection_threads
        WHERE organization_snooze_id IS NOT NULL
          AND deleted_at IS NULL AND archived_at IS NULL AND deleting_at IS NULL
        ORDER BY organization_snooze_until ASC, thread_id ASC
        LIMIT 100
      `;
      assert.ok(
        plan.some((row) => row.detail.includes("idx_projection_threads_pending_snooze")),
        JSON.stringify(plan),
      );
    }),
  );
});
