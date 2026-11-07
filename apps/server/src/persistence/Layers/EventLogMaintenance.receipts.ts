/**
 * Command-ledger pruning: receipts with their claims, and claims whose receipt is gone.
 *
 * - Receipts with `result_sequence` at or below `min(floor, retained_through_sequence)` are
 *   deleted with their claim in one transaction: a receipt is kept no longer than the events it
 *   produced. A retry that found the receipt but not its events could only fail ("did not
 *   produce a delivery outcome"); once both are gone a retry runs as a new command. Events are
 *   kept at least 24 hours (the hot window), so ordinary retries still see both.
 * - Orphan claims (no receipt) older than 7 days and older than the floor's first event are
 *   deleted on their own. A claim is written when command processing starts and its receipt
 *   when the command commits, so an orphan is a command that never committed (failed, or the
 *   process died) or whose receipt another path removed (`EntityPurge`). A claim younger than
 *   7 days may still be in flight and is never touched.
 * - Both keep anything a recovery path still reads by command ID: unfinished bootstraps
 *   (`WorktreeLifecycle.preflight`), direct-cleanup intents and plans (finalize detection and
 *   digest conflicts), project-workspace native operations and worktree operation items, and
 *   prepared organization operations.
 *
 * Every batch is bounded by row count. No-op commands record the head sequence they saw, so up
 * to ~24,000 receipts can share one `result_sequence`; a batch therefore takes at most `limit`
 * receipts in `(result_sequence, rowid)` order, and the cursor only passes a sequence once all
 * of its prunable receipts are gone. (Deleting whole sequence groups made single batches of
 * 15,000-24,000 rows that held the worker for 350-620 ms on the real 8 GB database.)
 *
 * @module EventLogMaintenance.receipts
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";

/** A claim with no receipt younger than this may still be in flight. */
export const ORPHAN_CLAIM_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const changes = (sql: SqlClient.SqlClient) =>
  sql<{ readonly count: number }>`SELECT changes() AS "count"`.pipe(
    Effect.map((rows) => rows[0]?.count ?? 0),
  );

/** Command IDs a recovery path still reads; `alias` is the outer row with a `command_id`. */
export const keptCommandSql = (alias: string) => `
  EXISTS (SELECT 1 FROM orchestration_bootstrap_recipes AS recipe
    WHERE recipe.parent_command_id = ${alias}.command_id)
  OR EXISTS (SELECT 1 FROM direct_resource_cleanup_intents AS intent
    WHERE intent.source_command_id = ${alias}.command_id)
  OR EXISTS (SELECT 1 FROM direct_resource_cleanup_plans AS plan
    WHERE plan.finalize_command_id = ${alias}.command_id)
  OR EXISTS (SELECT 1 FROM project_workspace_native_operations AS native
    WHERE native.command_id = ${alias}.command_id)
  OR EXISTS (SELECT 1 FROM worktree_operation_items AS item
    WHERE item.command_id = ${alias}.command_id)
  OR EXISTS (SELECT 1 FROM thread_organization_operations AS operation
    WHERE operation.operation_id = ${alias}.command_id AND operation.status = 'prepared')`;

/** Binds cursor, upper sequence, limit. Exposed for the query-plan test. */
export const prunableReceiptsSql = (column: "rowid" | "command_id" | "result_sequence") => `
  SELECT receipt.${column} FROM orchestration_command_receipts AS receipt
  WHERE receipt.result_sequence > ? AND receipt.result_sequence <= ?
    AND NOT (${keptCommandSql("receipt")})
  ORDER BY receipt.result_sequence, receipt.rowid LIMIT ?`;

export interface ReceiptPruneResult {
  readonly receipts: number;
  readonly claims: number;
  /** Everything at or below this sequence is pruned or deliberately kept. */
  readonly cursor: number;
}

/** Prunes at most `limit` receipts after `cursor`, and their claims. */
export const pruneReceipts = Effect.fn("EventLogMaintenance.pruneReceipts")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly cursor: number;
      readonly throughSequence: number;
      readonly limit: number;
    },
  ) {
    if (input.throughSequence <= input.cursor) {
      return { receipts: 0, claims: 0, cursor: input.cursor } satisfies ReceiptPruneResult;
    }
    const limit = Math.max(1, Math.floor(input.limit));
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        // The `limit`-th receipt in order bounds the range, so no scan walks further than that.
        const [edge] = yield* sql<{ readonly sequence: number }>`
          SELECT result_sequence AS "sequence" FROM orchestration_command_receipts
          WHERE result_sequence > ${input.cursor} AND result_sequence <= ${input.throughSequence}
          ORDER BY result_sequence LIMIT 1 OFFSET ${limit - 1}
        `;
        const upper = edge?.sequence ?? input.throughSequence;
        const params = [input.cursor, upper, limit] as const;
        const [selected] = yield* sql.unsafe<{ readonly count: number; readonly last: number }>(
          `SELECT COUNT(*) AS "count", MAX(result_sequence) AS "last"
           FROM (${prunableReceiptsSql("result_sequence")})`,
          params,
        );
        const count = selected?.count ?? 0;
        let claims = 0;
        let receipts = 0;
        if (count > 0) {
          yield* sql.unsafe(
            `DELETE FROM orchestration_command_receipt_claims
             WHERE command_id IN (${prunableReceiptsSql("command_id")})`,
            params,
          );
          claims = yield* changes(sql);
          yield* sql.unsafe(
            `DELETE FROM orchestration_command_receipts WHERE rowid IN (${prunableReceiptsSql("rowid")})`,
            params,
          );
          receipts = yield* changes(sql);
        }
        // A full batch may have left prunable receipts in its last sequence.
        const cursor = count < limit ? upper : Math.max(input.cursor, (selected?.last ?? 0) - 1);
        return { receipts, claims, cursor } satisfies ReceiptPruneResult;
      }),
    );
  },
  Effect.mapError(toPersistenceSqlError("EventLogMaintenance.pruneReceipts")),
);

export interface OrphanClaimPruneResult {
  readonly claims: number;
  /** Claims examined (the batch size the sizer learns from). */
  readonly scanned: number;
  /** Every claim at or below this rowid was examined in the current pass. */
  readonly cursor: number;
  /** The pass reached the end of the table or a claim too young to judge. */
  readonly passComplete: boolean;
}

/**
 * Examines the next `limit` claims after `cursor` (rowid order, which is claim order) and
 * deletes the orphans among them that are older than 7 days and than the first event above
 * `floor`. The pass ends at the first claim younger than that.
 */
export const pruneOrphanClaims = Effect.fn("EventLogMaintenance.pruneOrphanClaims")(
  function* (
    sql: SqlClient.SqlClient,
    input: {
      readonly cursor: number;
      readonly floor: number;
      readonly limit: number;
      readonly nowMs: number;
    },
  ) {
    const limit = Math.max(1, Math.floor(input.limit));
    const retentionCutoff = new Date(input.nowMs - ORPHAN_CLAIM_MIN_AGE_MS).toISOString();
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [floorEvent] = yield* sql<{ readonly occurredAt: string }>`
          SELECT occurred_at AS "occurredAt" FROM orchestration_events
          WHERE sequence > ${input.floor} ORDER BY sequence LIMIT 1
        `;
        const cutoff =
          floorEvent !== undefined && floorEvent.occurredAt < retentionCutoff
            ? floorEvent.occurredAt
            : retentionCutoff;
        const [window] = yield* sql<{ readonly last: number | null; readonly count: number }>`
          SELECT MAX(rowid) AS "last", COUNT(*) AS "count" FROM (
            SELECT rowid FROM orchestration_command_receipt_claims
            WHERE rowid > ${input.cursor} ORDER BY rowid LIMIT ${limit}
          )
        `;
        if (window === undefined || window.last === null || window.count === 0) {
          return { claims: 0, scanned: 0, cursor: input.cursor, passComplete: true };
        }
        const [young] = yield* sql<{ readonly rowid: number }>`
          SELECT rowid AS "rowid" FROM orchestration_command_receipt_claims
          WHERE rowid > ${input.cursor} AND rowid <= ${window.last} AND claimed_at >= ${cutoff}
          ORDER BY rowid LIMIT 1
        `;
        const upper = young === undefined ? window.last : young.rowid - 1;
        yield* sql.unsafe(
          `DELETE FROM orchestration_command_receipt_claims WHERE rowid IN (
             SELECT claim.rowid FROM orchestration_command_receipt_claims AS claim
             WHERE claim.rowid > ? AND claim.rowid <= ?
               AND NOT EXISTS (SELECT 1 FROM orchestration_command_receipts AS receipt
                 WHERE receipt.command_id = claim.command_id)
               AND NOT (${keptCommandSql("claim")})
           )`,
          [input.cursor, upper],
        );
        const claims = yield* changes(sql);
        return {
          claims,
          scanned: window.count,
          cursor: Math.max(input.cursor, upper),
          passComplete: young !== undefined || window.count < limit,
        } satisfies OrphanClaimPruneResult;
      }),
    );
  },
  Effect.mapError(toPersistenceSqlError("EventLogMaintenance.pruneOrphanClaims")),
);
