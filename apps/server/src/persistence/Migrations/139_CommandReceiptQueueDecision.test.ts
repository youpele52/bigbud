import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("preserves existing accepted receipts and permits additive queue decision metadata", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 138 });
    yield* sql`INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error) VALUES ('old', 'thread', 'thread', '2026-10-28T00:00:00.000Z', 1, 'accepted', NULL)`;
    yield* runMigrations({ toMigrationInclusive: 139 });
    const rows =
      yield* sql`SELECT status, queue_decision_reason FROM orchestration_command_receipts WHERE command_id = 'old'`;
    assert.deepEqual(rows, [{ status: "accepted", queue_decision_reason: null }]);
    yield* sql`INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, rejection_reason, queue_decision_reason, error) VALUES ('blocked', 'thread', 'thread', '2026-10-28T00:00:00.000Z', 1, 'rejected', 'other', 'queue_busy', NULL)`;
    const blocked =
      yield* sql`SELECT queue_decision_reason FROM orchestration_command_receipts WHERE command_id = 'blocked'`;
    assert.deepEqual(blocked, [{ queue_decision_reason: "queue_busy" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
