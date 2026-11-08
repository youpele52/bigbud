import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { patchVerifiedBaselineTurnUsage } from "./157_ProjectionTurnUsageAttribution.baselines.ts";
import {
  backfilledUsageColumnsSql,
  missingAttributionSql,
  REQUEST_USAGE_TABLE,
  requestKeySql,
} from "./157_ProjectionTurnUsageAttribution.columns.ts";
import {
  dropRequestUsageTables,
  stageRequestUsage,
} from "./157_ProjectionTurnUsageAttribution.requests.ts";

/** Merges the staged request usage into every live turn still missing attribution. */
export const BACKFILL_LIVE_TURNS_SQL = `
  UPDATE projection_turns AS t SET usage_provider = b.provider, usage_model = b.model,
    usage_interaction_mode = b.mode, usage_attribution_source = b.source
  FROM (
    SELECT c.row_id, ${backfilledUsageColumnsSql(
      (column) => `c.${column}`,
      (column) => `r.${column}`,
    )}
    FROM ${REQUEST_USAGE_TABLE} AS r
    CROSS JOIN projection_turns AS c ON ${requestKeySql("r", (column) => `c.${column}`)}
    WHERE ${missingAttributionSql((column) => `c.${column}`)}
  ) AS b
  WHERE t.row_id = b.row_id
`;

/**
 * Persists usage attribution for turns projected before migration 133 recorded it.
 *
 * Usage used to recover the provider, model and interaction mode of those turns by reading
 * their `thread.turn-start-requested` event from `orchestration_events` on every query.
 * Background compaction (migration 156) deletes those events below the hot window, which would
 * turn old usage into "unknown". This copies the same answer into `projection_turns` once, so
 * usage reads only projections.
 *
 * - One rule, shared with the thread-turns projector (`deriveTurnRequestUsage`): the projector
 *   now attributes a request without `usageAttribution` itself, and this migration applies the
 *   same rule to the same decoded requests, so a replay from sequence 0 or from any baseline
 *   reproduces the backfilled rows. Only a turn missing a provider or model (NULL or `unknown`)
 *   is filled, only from an unambiguous request (see `stageRequestUsage`), never overwriting a
 *   known value. Complete attribution is marked `backfill` in `usage_attribution_source`, so the
 *   turn repository treats it as recorded (see `backfilledUsageColumnsSql`).
 * - Projection baselines stay replayable: a verified baseline predates this backfill and the
 *   request events precede it, so a replay from it could never reproduce the backfilled rows and
 *   every new candidate would fail verification, pinning the event-log cleanup floor. The same
 *   rule is therefore applied to the turn rows of every verified baseline, including turns still
 *   pending there, and unverified candidates (captured before the backfill) are dropped to be
 *   recaptured. Nothing reads candidate or rejected rows: verification failures are only
 *   remembered in memory, and a rejected candidate is deleted rather than kept.
 * - Migrations finish before event-log maintenance starts, so the source events still exist.
 *   Requests replay cannot decode are skipped rather than failing startup.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* stageRequestUsage(sql);
  yield* sql.unsafe(BACKFILL_LIVE_TURNS_SQL);
  yield* sql`
    DELETE FROM projection_baseline_rows WHERE baseline_id NOT IN (
      SELECT baseline_id FROM projection_baselines WHERE verification_status = 'verified')
  `;
  yield* sql`DELETE FROM projection_baselines WHERE verification_status <> 'verified'`;
  yield* patchVerifiedBaselineTurnUsage(sql);
  yield* dropRequestUsageTables(sql);
});
