import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.layer(NodeSqliteClient.layerMemory())("121_ThreadRetentionSelectionMode", (it) => {
  it.effect("keeps accepted policies and nonterminal runs in legacy mode", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 120 });
      yield* sql`INSERT INTO thread_retention_policy_authority
        (singleton_id, policy, source, updated_at)
        VALUES (1, '7-days', 'explicit', '2026-09-23T00:00:00.000Z')`;
      yield* sql`INSERT INTO thread_retention_runs
        (run_id, trigger_kind, policy, cutoff_at, status, cursor_last_activity_at,
          cursor_thread_id, selected_count, created_at, updated_at)
        VALUES ('accepted', 'scheduled', '7-days', '2026-09-16T00:00:00.000Z',
          'deferred', '2026-09-15T00:00:00.000Z', 'thread', 4,
          '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z')`;
      yield* sql`INSERT INTO thread_retention_run_items
        (run_id, thread_id, expected_last_activity_at, deletion_command_id,
          status, created_at, updated_at)
        VALUES ('accepted', 'thread', '2026-09-15T00:00:00.000Z',
          'delete-thread', 'deletion_requested',
          '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z')`;
      yield* runMigrations();
      const policy = yield* sql`SELECT policy, selection_mode, age_criterion
        FROM thread_retention_policy_authority`;
      assert.deepEqual(policy, [
        {
          policy: "7-days",
          selection_mode: "legacy-subtree",
          age_criterion: "last-conversation-activity",
        },
      ]);
      const runs = yield* sql`SELECT status, cursor_last_activity_at, cursor_thread_id,
        selected_count, uncertain_count, selection_mode, age_criterion FROM thread_retention_runs`;
      assert.deepEqual(runs, [
        {
          status: "deferred",
          cursor_last_activity_at: "2026-09-15T00:00:00.000Z",
          cursor_thread_id: "thread",
          selected_count: 4,
          uncertain_count: 1,
          selection_mode: "legacy-subtree",
          age_criterion: "last-conversation-activity",
        },
      ]);
    }),
  );
});

it("retains an enabled legacy policy and accepted run after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bigbud-retention-upgrade-"));
  const filename = join(directory, "state.sqlite");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 120 });
        yield* sql`INSERT INTO thread_retention_policy_authority
        (singleton_id, policy, source, updated_at)
        VALUES (1, '14-days', 'explicit', '2026-09-23T00:00:00.000Z')`;
        yield* sql`INSERT INTO thread_retention_runs
        (run_id, trigger_kind, policy, cutoff_at, status, active_slot,
          cursor_last_activity_at, cursor_thread_id, created_at, updated_at)
        VALUES ('accepted-restart', 'scheduled', '14-days', '2026-09-09T00:00:00.000Z',
          'selecting', 1, '2026-09-08T00:00:00.000Z', 'thread',
          '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z')`;
        yield* runMigrations();
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        const authority = yield* sql`SELECT policy, selection_mode, age_criterion
        FROM thread_retention_policy_authority`;
        assert.deepEqual(authority, [
          {
            policy: "14-days",
            selection_mode: "legacy-subtree",
            age_criterion: "last-conversation-activity",
          },
        ]);
        const run = yield* sql`SELECT status, active_slot, cutoff_at, cursor_last_activity_at,
        cursor_thread_id, selection_mode, age_criterion FROM thread_retention_runs
        WHERE run_id = 'accepted-restart'`;
        assert.deepEqual(run, [
          {
            status: "selecting",
            active_slot: 1,
            cutoff_at: "2026-09-09T00:00:00.000Z",
            cursor_last_activity_at: "2026-09-08T00:00:00.000Z",
            cursor_thread_id: "thread",
            selection_mode: "legacy-subtree",
            age_criterion: "last-conversation-activity",
          },
        ]);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
