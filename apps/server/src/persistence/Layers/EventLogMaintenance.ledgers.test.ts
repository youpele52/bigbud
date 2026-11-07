import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeEventLogMaintenance } from "./EventLogMaintenance.ts";
import { EVENT_ID_PRUNE_SELECT } from "./EventLogMaintenance.ledgers.ts";
import {
  countRows,
  DAY_MS,
  IDLE_SIGNALS,
  NOW_MS,
  seedCompactableLog,
  seedReceipts,
  TEST_HOT_WINDOW,
} from "./EventLogMaintenance.test.helpers.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const drain = Effect.gen(function* () {
  const maintenance = yield* makeEventLogMaintenance({
    now: () => NOW_MS,
    readSignals: () => Effect.succeed(IDLE_SIGNALS),
    floorInputs: () => ({ reactorCursor: null, deliveryAcknowledged: null }),
    hotWindow: TEST_HOT_WINDOW,
  });
  for (let tick = 0; tick < 50; tick += 1) {
    if ((yield* maintenance.service.runTick).drained) break;
  }
});

const commandIds = (sql: SqlClient.SqlClient, table: string) =>
  sql
    .unsafe<{ readonly commandId: string }>(
      `SELECT command_id AS "commandId" FROM ${table} ORDER BY command_id`,
    )
    .pipe(Effect.map((rows) => new Set(rows.map((row) => row.commandId))));

it.effect("keeps referenced receipts and prunes the rest together with their claims", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = new Date(NOW_MS).toISOString();
    yield* seedCompactableLog(sql, { count: 1_000, receipts: false });
    yield* seedReceipts(sql, { start: 1, end: 500 });
    // Below the floor but only 2 days old.
    yield* seedReceipts(sql, { start: 501, end: 600, ageMs: 2 * DAY_MS });
    yield* seedReceipts(sql, { start: 601, end: 1_000 });

    yield* sql`
      INSERT INTO orchestration_bootstrap_recipes (parent_command_id, recipe_version, created_at)
      VALUES ('command-10', 'v1', ${now})
    `;
    yield* sql`
      INSERT INTO direct_resource_cleanup_intents (intent_id, event_id, source_command_id,
        source_payload_digest_version, source_payload_digest, entity_kind, entity_id,
        deletion_mode, deletion_requested_at, state, closed_at)
      VALUES ('intent-1', 'event-gone', 'command-20', 'v1', 'digest', 'thread', 'thread-1',
        'single', ${now}, 'completed', ${now})
    `;
    yield* sql`
      INSERT INTO direct_resource_cleanup_plans (operation_id, intent_id, finalize_command_id,
        finalize_payload_json, finalize_payload_digest_version, finalize_payload_digest,
        plan_digest, expected_platform, state, created_at, updated_at, completed_at)
      VALUES ('plan-1', 'intent-1', 'command-30', '{}', 'v1', 'digest', 'plan', 'darwin/arm64',
        'completed', ${now}, ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO worktree_operations (operation_id, request_digest, kind, repository, cwd,
        source_path, destination_path, canonical_path, device, inode, branch, phase, created_at)
      VALUES ('op-1', 'digest', 'rename', '/repo', '/repo', '/old', '/new', '/old', 1, 2,
        'main', 'completed', ${now})
    `;
    yield* sql`
      INSERT INTO worktree_operation_items (operation_id, thread_id, old_path, new_path, command_id)
      VALUES ('op-1', 'thread-1', '/old', '/new', 'command-40')
    `;
    yield* sql`
      INSERT INTO project_workspace_native_operations (operation_id, command_id, project_id,
        request_json, source_path, destination_path, phase, steps_json, created_at, updated_at)
      VALUES ('op-1', 'command-50', 'project', '{}', '/old', '/new', 'committed', '[]', ${now}, ${now})
    `;
    // A prepared organization operation (no events yet) keeps its receipt: recovery reads it.
    yield* sql`
      INSERT INTO thread_organization_operations (operation_id, occurrence_id, attempt, thread_id,
        payload_digest, payload_json, created_at_ms, status, outcome_json)
      VALUES ('organization-op', 'occurrence-1', 0, 'thread-1', 'digest', '{}', 0, 'prepared', NULL)
    `;
    const oldAt = new Date(NOW_MS - 8 * DAY_MS).toISOString();
    yield* sql`
      INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id,
        accepted_at, result_sequence, status, error)
      VALUES ('organization-op', 'thread', 'thread-1', ${oldAt}, 70, 'accepted', NULL)
    `;
    yield* sql`
      INSERT INTO orchestration_command_receipt_claims (command_id, payload_digest_version,
        payload_digest, claimed_at)
      VALUES ('organization-op', 'v1', 'digest', ${oldAt})
    `;
    const kept = [
      "command-10",
      "command-20",
      "command-30",
      "command-40",
      "command-50",
      "organization-op",
    ];

    yield* drain;

    assert.equal(yield* countRows(sql, "orchestration_events"), 100);
    const receipts = yield* commandIds(sql, "orchestration_command_receipts");
    const claims = yield* commandIds(sql, "orchestration_command_receipt_claims");
    for (const commandId of kept) assert.isTrue(receipts.has(commandId), commandId);
    assert.isFalse(receipts.has("command-11"));
    assert.isFalse(receipts.has("command-500"));
    // Receipts younger than 7 days and receipts above the floor stay. The cursor waits at the
    // first young receipt; old ones after it go when a batch reaches them, or once it ages.
    for (let sequence = 1; sequence <= 1_000; sequence += 1) {
      const commandId = `command-${sequence}`;
      if (kept.includes(commandId)) continue;
      if (sequence <= 500) assert.isFalse(receipts.has(commandId), commandId);
      else if (sequence <= 600 || sequence > 900) assert.isTrue(receipts.has(commandId), commandId);
    }
    // Claims go only with their receipt.
    assert.deepEqual([...claims].toSorted(), [...receipts].toSorted());
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("prunes event IDs and gap rows below retained_through through the sequence index", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedCompactableLog(sql, { count: 2_000, receipts: false });
    // Gap rows recorded by per-entity deletion inside the range compaction will cover.
    yield* sql`DELETE FROM orchestration_events WHERE sequence BETWEEN 100 AND 299`;
    yield* sql`
      INSERT INTO orchestration_event_gaps (sequence, event_id, created_at)
      SELECT sequence, event_id, '2026-11-07T00:00:00.000Z' FROM orchestration_event_ids
      WHERE sequence BETWEEN 100 AND 299
    `;
    yield* sql`DELETE FROM orchestration_event_ids WHERE sequence BETWEEN 100 AND 299`;

    yield* drain;

    assert.equal(yield* countRows(sql, "orchestration_event_gaps"), 0);
    const ids = yield* sql<{ readonly first: number; readonly count: number }>`
      SELECT MIN(sequence) AS "first", COUNT(*) AS "count" FROM orchestration_event_ids
    `;
    assert.deepEqual(ids[0], { first: 1_901, count: 100 });

    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${EVENT_ID_PRUNE_SELECT}`,
      [1_900, 1_000],
    );
    assert.match(plan.map((row) => row.detail).join("\n"), /idx_orchestration_event_ids_sequence/);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("drops the unread correlation-id index and keeps the column", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const indexes = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orchestration_events'
    `;
    assert.notInclude(
      indexes.map((row) => row.name),
      "idx_orch_events_correlation_id",
    );
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('orchestration_events')
    `;
    assert.include(
      columns.map((row) => row.name),
      "correlation_id",
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
