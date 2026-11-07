import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  prunableReceiptsSql,
  pruneOrphanClaims,
  pruneReceipts,
} from "./EventLogMaintenance.receipts.ts";
import { countRows, DAY_MS, NOW_MS, seedEvents } from "./EventLogMaintenance.test.helpers.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const iso = (ageMs: number) => new Date(NOW_MS - ageMs).toISOString();

/** `count` receipts (with claims) that all share `sequence`, like no-op commands at one head. */
const seedReceiptGroup = (
  sql: SqlClient.SqlClient,
  input: { readonly prefix: string; readonly sequence: number; readonly count: number },
) =>
  Effect.gen(function* () {
    yield* sql`
      WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < ${input.count})
      INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id,
        accepted_at, result_sequence, status, error)
      SELECT ${input.prefix} || value, 'thread', 'thread-1', ${iso(8 * DAY_MS)}, ${input.sequence},
        'accepted', NULL FROM n
    `;
    yield* sql`
      INSERT INTO orchestration_command_receipt_claims (command_id, payload_digest_version,
        payload_digest, claimed_at)
      SELECT command_id, 'v1', 'digest', accepted_at FROM orchestration_command_receipts
      WHERE command_id LIKE ${`${input.prefix}%`}
    `;
  });

it.effect("drains a sequence shared by thousands of receipts in batches of at most `limit`", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedReceiptGroup(sql, { prefix: "before-", sequence: 10, count: 50 });
    yield* seedReceiptGroup(sql, { prefix: "group-", sequence: 20, count: 3_000 });
    yield* seedReceiptGroup(sql, { prefix: "after-", sequence: 30, count: 50 });
    // A recovery path still reads this one, in the middle of the group.
    yield* sql`
      INSERT INTO orchestration_bootstrap_recipes (parent_command_id, recipe_version, created_at)
      VALUES ('group-1500', 'v1', ${iso(0)})
    `;
    let cursor = 0;
    const deleted: Array<number> = [];
    for (let batch = 0; batch < 100 && cursor < 40; batch += 1) {
      const result = yield* pruneReceipts(sql, {
        cursor,
        throughSequence: 40,
        limit: 200,
        nowMs: NOW_MS,
      });
      assert.isAtMost(result.receipts, 200);
      assert.equal(result.claims, result.receipts);
      assert.isNull(result.blockedUntilMs);
      // The cursor never passes the group while prunable receipts remain in it.
      if (cursor < 20 && result.cursor >= 20) {
        const left = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count" FROM orchestration_command_receipts
          WHERE result_sequence = 20 AND command_id <> 'group-1500'
        `;
        assert.equal(left[0]?.count, 0);
      }
      cursor = result.cursor;
      deleted.push(result.receipts);
    }
    assert.equal(cursor, 40);
    assert.equal(
      deleted.reduce((sum, rows) => sum + rows, 0),
      3_099,
    );
    assert.isAtLeast(deleted.length, 16);
    assert.equal(yield* countRows(sql, "orchestration_command_receipts"), 1);
    assert.equal(yield* countRows(sql, "orchestration_command_receipt_claims"), 1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("waits before a young receipt inside a shared sequence", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedReceiptGroup(sql, { prefix: "group-", sequence: 20, count: 500 });
    yield* sql`
      UPDATE orchestration_command_receipts SET accepted_at = ${iso(2 * DAY_MS)}
      WHERE command_id = 'group-500'
    `;
    let result = yield* pruneReceipts(sql, {
      cursor: 0,
      throughSequence: 40,
      limit: 200,
      nowMs: NOW_MS,
    });
    for (let batch = 0; batch < 10 && result.blockedUntilMs === null; batch += 1) {
      result = yield* pruneReceipts(sql, {
        cursor: result.cursor,
        throughSequence: 40,
        limit: 200,
        nowMs: NOW_MS,
      });
    }
    assert.equal(result.cursor, 19);
    assert.equal(result.blockedUntilMs, NOW_MS - 2 * DAY_MS + 7 * DAY_MS);
    assert.equal(yield* countRows(sql, "orchestration_command_receipts"), 1);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("selects prunable receipts in index order without a sort", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${prunableReceiptsSql("rowid")}`,
      [0, 10, iso(0), 100],
    );
    const details = plan.map((row) => row.detail).join("\n");
    assert.match(details, /idx_orch_command_receipts_sequence/);
    assert.notMatch(details, /TEMP B-TREE/);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("prunes old orphan claims in bounded passes and keeps live or referenced ones", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The floor's first event is recent, so only the 7-day rule applies.
    const { end } = yield* seedEvents(sql, { count: 10, ageMs: DAY_MS });
    const claim = (commandId: string, ageMs: number) => sql`
      INSERT INTO orchestration_command_receipt_claims (command_id, payload_digest_version,
        payload_digest, claimed_at) VALUES (${commandId}, 'v1', 'digest', ${iso(ageMs)})
    `;
    for (let index = 0; index < 250; index += 1) yield* claim(`orphan-${index}`, 9 * DAY_MS);
    yield* claim("with-receipt", 9 * DAY_MS);
    yield* sql`
      INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id,
        accepted_at, result_sequence, status, error)
      VALUES ('with-receipt', 'thread', 'thread-1', ${iso(9 * DAY_MS)}, 1, 'accepted', NULL)
    `;
    // Cleanup intents read their source command's claim (digest).
    yield* claim("cleanup-source", 9 * DAY_MS);
    yield* sql`
      INSERT INTO direct_resource_cleanup_intents (intent_id, event_id, source_command_id,
        source_payload_digest_version, source_payload_digest, entity_kind, entity_id,
        deletion_mode, deletion_requested_at)
      VALUES ('intent-1', 'event-1', 'cleanup-source', 'v1', 'digest', 'thread', 'thread-1',
        'single', ${iso(0)})
    `;
    // Possibly still in flight: younger than 7 days. It ends the pass.
    yield* claim("in-flight", 2 * DAY_MS);
    yield* claim("old-after-young", 9 * DAY_MS);

    let cursor = 0;
    let deleted = 0;
    for (let batch = 0; batch < 10; batch += 1) {
      const result = yield* pruneOrphanClaims(sql, {
        cursor,
        floor: end,
        limit: 100,
        nowMs: NOW_MS,
      });
      assert.isAtMost(result.scanned, 100);
      cursor = result.cursor;
      deleted += result.claims;
      if (result.passComplete) break;
    }
    assert.equal(deleted, 250);
    const left = yield* sql<{ readonly commandId: string }>`
      SELECT command_id AS "commandId" FROM orchestration_command_receipt_claims ORDER BY rowid
    `;
    assert.deepEqual(
      left.map((row) => row.commandId),
      ["with-receipt", "cleanup-source", "in-flight", "old-after-young"],
    );
    // The next pass resumes from the cursor and stops at the same young claim.
    const again = yield* pruneOrphanClaims(sql, { cursor, floor: end, limit: 100, nowMs: NOW_MS });
    assert.deepEqual([again.claims, again.passComplete], [0, true]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("keeps orphan claims newer than the floor's first event", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The floor sits before events that are 30 days old: claims after them stay.
    const { start } = yield* seedEvents(sql, { count: 5, ageMs: 30 * DAY_MS });
    yield* sql`
      INSERT INTO orchestration_command_receipt_claims (command_id, payload_digest_version,
        payload_digest, claimed_at)
      VALUES ('older-than-floor', 'v1', 'digest', ${iso(31 * DAY_MS)}),
        ('newer-than-floor', 'v1', 'digest', ${iso(20 * DAY_MS)})
    `;
    const result = yield* pruneOrphanClaims(sql, {
      cursor: 0,
      floor: start - 1,
      limit: 100,
      nowMs: NOW_MS,
    });
    assert.equal(result.claims, 1);
    assert.isTrue(result.passComplete);
    const left = yield* sql<{ readonly commandId: string }>`
      SELECT command_id AS "commandId" FROM orchestration_command_receipt_claims
    `;
    assert.deepEqual(
      left.map((row) => row.commandId),
      ["newer-than-floor"],
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
