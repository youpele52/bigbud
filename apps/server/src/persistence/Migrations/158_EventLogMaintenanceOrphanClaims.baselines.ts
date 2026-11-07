import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  normalizeRow,
  withoutBaselineSurrogateKey,
} from "../Layers/ProjectionBaselines.capture.ts";
import { PROJECTION_BASELINE_FORMAT_VERSION } from "../ProjectionBaselineRows.ts";
import { rewriteBaselineTurnRows } from "../ProjectionBaselineRows.turnRewrite.ts";
import type { BaselinePayloadRow } from "../Services/ProjectionBaselines.ts";

const TURNS_TABLE = "projection_turns";

/** One page of stored turn rows in the current baseline form: without `row_id`. */
const stripRowIds = (rows: ReadonlyArray<BaselinePayloadRow>) =>
  Effect.sync(() =>
    rows.map((entry) => {
      const row = JSON.parse(entry.rowJson) as Record<string, unknown>;
      const stripped = withoutBaselineSurrogateKey(TURNS_TABLE, row);
      return stripped === row ? entry.rowJson : JSON.stringify(normalizeRow(stripped));
    }),
  );

/**
 * Moves stored baselines to the turn row form capture now writes: `projection_turns` rows
 * without their `row_id` (see `PROJECTION_BASELINE_SURROGATE_KEYS`), re-sorted by their text and
 * rehashed, so each verified baseline hashes exactly as a fresh capture of the same state does.
 *
 * - Runs after migration 157, whose usage patch works on either form and leaves turn rows in
 *   capture order, and after 152, which converted legacy (format 1) baselines with their row
 *   ids. Both are rewritten here the same way.
 * - Unverified candidates are dropped: their hashes include `row_id`, so verification could only
 *   reject them. Nothing reads candidate or rejected rows; the next compaction recaptures one.
 * - The storage format (one stored row per projection row) is unchanged, so `format_version`
 *   stays 2: a stored hash is only ever checked against the rows it was computed from, restore
 *   accepts turn rows with or without `row_id`, and verification compares two fresh captures.
 * - Bounded: rows are read and staged 500 at a time and SQLite sorts the staged turn rows; one
 *   pass over the rest of each verified baseline checks and recomputes its hash.
 */
export const rehashVerifiedBaselinesWithoutTurnRowIds = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM projection_baselines WHERE verification_status <> 'verified'`;
    yield* sql`
      DELETE FROM projection_baseline_rows
      WHERE baseline_id NOT IN (SELECT baseline_id FROM projection_baselines)
    `;
    const baselines = yield* sql<{ readonly baselineId: number; readonly payloadHash: string }>`
      SELECT baseline_id AS "baselineId", payload_hash AS "payloadHash"
      FROM projection_baselines
      WHERE verification_status = 'verified'
        AND format_version = ${PROJECTION_BASELINE_FORMAT_VERSION}
      ORDER BY baseline_id
    `;
    for (const baseline of baselines) {
      yield* rewriteBaselineTurnRows(sql, baseline, stripRowIds);
    }
  });
