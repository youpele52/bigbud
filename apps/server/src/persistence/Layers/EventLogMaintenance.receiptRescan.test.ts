import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { isReceiptRescanDue, RECEIPT_RESCAN_INTERVAL_MS } from "./EventLogMaintenance.batches.ts";
import { makeEventLogMaintenance } from "./EventLogMaintenance.ts";
import {
  IDLE_SIGNALS,
  NOW_MS,
  seedCompactableLog,
  TEST_HOT_WINDOW,
} from "./EventLogMaintenance.test.helpers.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

it("rescans receipts on the first full tick and then once a day", () => {
  assert.isTrue(isReceiptRescanDue(null, NOW_MS));
  assert.isFalse(isReceiptRescanDue(NOW_MS, NOW_MS + RECEIPT_RESCAN_INTERVAL_MS - 1));
  assert.isTrue(isReceiptRescanDue(NOW_MS, NOW_MS + RECEIPT_RESCAN_INTERVAL_MS));
});

const receiptExists = (sql: SqlClient.SqlClient, commandId: string) =>
  sql<{ readonly count: number }>`
    SELECT
      (SELECT COUNT(*) FROM orchestration_command_receipts WHERE command_id = ${commandId}) +
      (SELECT COUNT(*) FROM orchestration_command_receipt_claims WHERE command_id = ${commandId})
      AS "count"
  `.pipe(Effect.map((rows) => rows[0]?.count ?? 0));

it.effect("prunes a receipt kept on purpose once its reason ends, at the next daily rescan", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedCompactableLog(sql, { count: 2_000 });
    // An unfinished bootstrap still reads this command's receipt.
    yield* sql`
      INSERT INTO orchestration_bootstrap_recipes (parent_command_id, recipe_version, created_at)
      VALUES ('command-500', 'v1', ${new Date(NOW_MS).toISOString()})
    `;
    let nowMs = NOW_MS;
    const maintenance = yield* makeEventLogMaintenance({
      now: () => nowMs,
      readSignals: () => Effect.succeed(IDLE_SIGNALS),
      floorInputs: () => ({ reactorCursor: null, deliveryAcknowledged: null }),
      hotWindow: TEST_HOT_WINDOW,
    });
    const drain = Effect.gen(function* () {
      for (let tick = 0; tick < 50; tick += 1) {
        const report = yield* maintenance.service.runTick;
        assert.isFalse(report.failed);
        if (report.drained) return;
      }
      assert.fail("maintenance did not drain");
    });
    yield* drain;
    assert.equal(yield* receiptExists(sql, "command-500"), 2, "kept with its claim");
    const [state] = yield* sql<{ readonly cursor: number }>`
      SELECT receipts_through_sequence AS "cursor" FROM event_log_maintenance_state
    `;
    assert.isAbove(state?.cursor ?? 0, 500, "the cursor moved past the kept receipt");

    // The bootstrap finishes. Before the rescan is due, the receipt stays.
    yield* sql`DELETE FROM orchestration_bootstrap_recipes WHERE parent_command_id = 'command-500'`;
    nowMs += 60_000;
    yield* drain;
    assert.equal(yield* receiptExists(sql, "command-500"), 2);

    nowMs = NOW_MS + RECEIPT_RESCAN_INTERVAL_MS;
    yield* drain;
    assert.equal(yield* receiptExists(sql, "command-500"), 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
