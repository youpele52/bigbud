import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Called only after canonical purge proof. Never infer ownership of orphan claims. */
export function makeDeleteProvenReceipts(sql: SqlClient.SqlClient) {
  return (input: {
    readonly entityKind: "project" | "thread";
    readonly entityId: ProjectId | ThreadId;
  }) => {
    const proven =
      input.entityKind === "thread"
        ? sql`
          WITH root AS (
            SELECT deletion_sequence FROM orchestration_deletion_markers
            WHERE entity_kind = 'thread' AND entity_id = ${input.entityId}
          )
          SELECT command_id FROM orchestration_command_receipts
          WHERE aggregate_kind = 'thread' AND aggregate_id IN (
            SELECT entity_id FROM orchestration_deletion_markers
            WHERE entity_kind = 'thread'
              AND deletion_sequence = (SELECT deletion_sequence FROM root)
          )
        `
        : sql`
          SELECT command_id FROM orchestration_command_receipts
          WHERE aggregate_kind = ${input.entityKind} AND aggregate_id = ${input.entityId}
            AND EXISTS (
              SELECT 1 FROM orchestration_deletion_markers AS marker
              JOIN projection_baselines AS baseline
                ON baseline.sequence = marker.covered_by_baseline_sequence
               AND baseline.verification_status = 'verified'
              WHERE marker.entity_kind = ${input.entityKind} AND marker.entity_id = ${input.entityId}
                AND orchestration_command_receipts.result_sequence <= marker.covered_by_baseline_sequence
            )
        `;
    return sql.withTransaction(
      Effect.gen(function* () {
        // Removing receipts first loses the only thread attribution of status claims,
        // turning a proven entity purge into a global unknown-metadata-work fence.
        // Use the SAME proven receipt set, atomically; unattributable claims survive.
        yield* sql`DELETE FROM orchestration_command_receipt_claims
          WHERE command_id IN (${proven})`;
        yield* sql`DELETE FROM orchestration_command_receipts
          WHERE command_id IN (${proven})`;
      }),
    );
  };
}
