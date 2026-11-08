import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { normalizeRow } from "../Layers/ProjectionBaselines.capture.ts";
import { PROJECTION_BASELINE_FORMAT_VERSION } from "../ProjectionBaselineRows.ts";
import { rewriteBaselineTurnRows } from "../ProjectionBaselineRows.turnRewrite.ts";
import type { BaselinePayloadRow } from "../Services/ProjectionBaselines.ts";
import {
  backfilledUsageColumnsSql,
  missingAttributionSql,
  REQUEST_USAGE_TABLE,
  requestKeySql,
} from "./157_ProjectionTurnUsageAttribution.columns.ts";

type RecoveredUsage = {
  readonly ordinal: number;
  readonly provider: string | null;
  readonly model: string | null;
  readonly mode: string | null;
  readonly source: string | null;
};

const rowValue = (column: string) => `json_extract(b.row_json, '$.${column}')`;

/**
 * The values the backfill rule gives the stored turn rows in one ordinal range that still miss
 * attribution and whose request is in `REQUEST_USAGE_TABLE`. Rows match on thread, prompt
 * message and request time only, as a replay would attribute them: a turn still pending in the
 * baseline (no `turn_id` yet) is patched like a started one, so a replay that starts it inherits
 * the recovered usage.
 */
const RECOVERED_PAGE_SQL = `
  SELECT b.ordinal, ${backfilledUsageColumnsSql(rowValue, (column) => `r.${column}`)}
  FROM projection_baseline_rows AS b
  JOIN ${REQUEST_USAGE_TABLE} AS r ON ${requestKeySql("r", rowValue)}
  WHERE b.baseline_id = ? AND b.table_name = 'projection_turns' AND b.ordinal BETWEEN ? AND ?
    AND ${missingAttributionSql(rowValue)}
`;

/**
 * One page of a baseline's turn rows with the recovered usage merged in, re-serialised the way
 * capture serialises them (sorted keys, `JSON.stringify`). Unpatched rows keep their text.
 */
const patchPage =
  (sql: SqlClient.SqlClient, baselineId: number) => (rows: ReadonlyArray<BaselinePayloadRow>) =>
    Effect.gen(function* () {
      if (rows.length === 0) return [];
      const recovered = yield* sql.unsafe<RecoveredUsage>(RECOVERED_PAGE_SQL, [
        baselineId,
        rows[0]!.ordinal,
        rows.at(-1)!.ordinal,
      ]);
      const byOrdinal = new Map(recovered.map((entry) => [entry.ordinal, entry]));
      return rows.map((entry) => {
        const usage = byOrdinal.get(entry.ordinal);
        if (usage === undefined) return entry.rowJson;
        return JSON.stringify(
          normalizeRow({
            ...(JSON.parse(entry.rowJson) as Record<string, unknown>),
            usage_provider: usage.provider,
            usage_model: usage.model,
            usage_interaction_mode: usage.mode,
            usage_attribution_source: usage.source,
          }),
        );
      });
    });

/**
 * Applies migration 157's backfill to the turn rows of every verified baseline and rehashes
 * the baselines it changed, so each equals what the projector, which now attributes these
 * requests itself, would have captured. Expects `REQUEST_USAGE_TABLE` to be staged.
 *
 * Patched rows are re-sorted by their new text, as capture orders rows, rather than keeping
 * their ordinals: once `row_id` is no longer part of a stored turn row (migration 158), two rows
 * of one thread can first differ in a `usage_*` column, so patching may reorder them.
 * A baseline whose stored rows no longer match its hash is left untouched (see
 * `rewriteBaselineTurnRows`).
 */
export const patchVerifiedBaselineTurnUsage = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const baselines = yield* sql<{ readonly baselineId: number; readonly payloadHash: string }>`
      SELECT baseline_id AS "baselineId", payload_hash AS "payloadHash"
      FROM projection_baselines
      WHERE verification_status = 'verified'
        AND format_version = ${PROJECTION_BASELINE_FORMAT_VERSION}
      ORDER BY baseline_id
    `;
    for (const baseline of baselines) {
      yield* rewriteBaselineTurnRows(sql, baseline, patchPage(sql, baseline.baselineId));
    }
  });
