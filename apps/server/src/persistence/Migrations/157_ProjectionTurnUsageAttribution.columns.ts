import { PROVIDER_INTERACTION_MODES } from "@bigbud/contracts/constants/runtime.constant.ts";

import { BACKFILL_USAGE_ATTRIBUTION_SOURCE } from "../ProjectionTurnRequestUsage.ts";

/**
 * Temp table of the usage each unambiguous request recovers, keyed like the turn rows it
 * attributes: `(thread_id, message_id, requested_at)` against a turn's
 * `(thread_id, pending_message_id, requested_at)`. Columns `provider`, `model`, `mode`, `source`
 * hold `deriveTurnRequestUsage` of the decoded request.
 */
export const REQUEST_USAGE_TABLE = "temp.projection_turn_usage_requests";

/** A turn still missing attribution: no provider or model, or an `unknown` one. */
export const missingAttributionSql = (current: (column: string) => string) =>
  `(${current("usage_provider")} IS NULL OR ${current("usage_model")} IS NULL
    OR ${current("usage_provider")} = 'unknown' OR ${current("usage_model")} = 'unknown')`;

/** Joins a turn row, read through `row(column)`, to its request in `REQUEST_USAGE_TABLE`. */
export const requestKeySql = (request: string, row: (column: string) => string) =>
  `${request}.thread_id = ${row("thread_id")} AND ${request}.message_id = ${row("pending_message_id")}
    AND ${request}.requested_at = ${row("requested_at")}`;

const QUOTED_MODES = PROVIDER_INTERACTION_MODES.map((mode) => `'${mode}'`).join(", ");

/**
 * Merges recovered usage into a turn, for live turns and for the turn rows of stored baselines
 * alike. Select-list expressions named `provider`, `model`, `mode` and `source`, from
 * `current(column)` (the turn's current value) and `recovered(column)` (a `REQUEST_USAGE_TABLE`
 * column):
 *
 * - provider and model: a known value is kept, then the recovered one;
 * - mode: a stored value is kept, then the recovered one;
 * - source: `backfill` only for a complete attribution that decodes as `UsageAttribution`, on a
 *   turn with none recorded. Partial results keep a NULL source; their columns still count for
 *   usage, and `thread.reverted` keeps them in place.
 *
 * On a turn with no usage columns yet (every turn projected before migration 133) the result is
 * exactly the recovered usage, which is what the projector now writes for the same request.
 */
export const backfilledUsageColumnsSql = (
  current: (column: string) => string,
  recovered: (column: string) => string,
) => {
  const provider = `COALESCE(NULLIF(${current("usage_provider")}, 'unknown'),
    ${recovered("provider")}, ${current("usage_provider")})`;
  const model = `COALESCE(NULLIF(${current("usage_model")}, 'unknown'),
    ${recovered("model")}, ${current("usage_model")})`;
  const mode = `COALESCE(${current("usage_interaction_mode")}, ${recovered("mode")})`;
  const source = current("usage_attribution_source");
  return `${provider} AS provider, ${model} AS model, ${mode} AS mode,
    CASE WHEN ${source} IS NULL AND ${provider} IS NOT NULL AND ${model} IS NOT NULL
      AND ${mode} IN (${QUOTED_MODES}) THEN '${BACKFILL_USAGE_ATTRIBUTION_SOURCE}'
      ELSE ${source} END AS source`;
};
