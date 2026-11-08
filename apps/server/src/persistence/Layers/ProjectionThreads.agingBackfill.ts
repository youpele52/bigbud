import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { isDeliberateOrganizationChange } from "../../orchestration/threadOrganization.aging.ts";

export const ORGANIZATION_AGE_PAGE_SIZE = 100;
type Progress = {
  after_thread_id: string;
  thread_id: string | null;
  revision: number;
  event_cursor: number;
  observed_revision: number;
  anchor: string | null;
  invalid: number;
  last_changed_at: string | null;
};
type HistoricalEvent = { sequence: number; event_type: string; payload_json: string | null };
const iso = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) &&
  Number.isFinite(Date.parse(value));

/** Only complete contiguous organization revisions prove an earlier age. Missing/corrupt
 * history (including compaction) preserves changedAt. Never infer intent from command IDs.
 * Called outside canonical event transactions. One stream page and one row publication per call.
 */
export const backfillOrganizationAgePage = (sql: SqlClient.SqlClient) =>
  sql.withTransaction(
    Effect.gen(function* () {
      // Acquire the SQLite write lock before reading progress/projection state.
      yield* sql`UPDATE projection_organization_age_backfill SET singleton = singleton WHERE singleton = 1`;
      const [progress] =
        yield* sql<Progress>`SELECT * FROM projection_organization_age_backfill WHERE singleton = 1`;
      if (!progress) return true;
      if (progress.thread_id === null) {
        const [thread] = yield* sql<{ thread_id: string; organization_revision: number }>`
        SELECT thread_id, organization_revision FROM projection_threads
        WHERE organization_age_provenance = 'pending' AND organization_revision > 0
          AND thread_id > ${progress.after_thread_id}
        ORDER BY thread_id LIMIT 1`;
        if (!thread) {
          // A restored/inserted earlier ID must not remain behind the cursor forever.
          yield* sql`UPDATE projection_organization_age_backfill SET after_thread_id = '' WHERE singleton = 1`;
          const [remaining] = yield* sql`SELECT 1 FROM projection_threads
          WHERE organization_age_provenance = 'pending' AND organization_revision > 0 LIMIT 1`;
          return remaining === undefined;
        }
        progress.thread_id = thread.thread_id;
        progress.revision = thread.organization_revision;
        progress.event_cursor = 0;
        progress.observed_revision = 0;
        progress.anchor = null;
        progress.last_changed_at = null;
        progress.invalid = 0;
      }
      const events = yield* sql<HistoricalEvent>`
      SELECT sequence, event_type,
        CASE WHEN event_type = 'thread.organization-updated' THEN payload_json ELSE NULL END AS payload_json
      FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${progress.thread_id}
        AND sequence > ${progress.event_cursor}
      ORDER BY sequence LIMIT ${ORGANIZATION_AGE_PAGE_SIZE}`;
      for (const event of events) {
        progress.event_cursor = event.sequence;
        if (event.event_type !== "thread.organization-updated") continue;
        try {
          const payload = JSON.parse(event.payload_json ?? "null");
          const organization = payload.organization;
          if (
            payload.threadId !== progress.thread_id ||
            !organization ||
            organization.revision !== progress.observed_revision + 1 ||
            !iso(organization.changedAt) ||
            !["move", "snooze", "snooze-expired", "idle", "archive", "unarchive"].includes(
              payload.reason,
            ) ||
            (payload.source !== undefined && !["deliberate", "automatic"].includes(payload.source))
          ) {
            progress.invalid = 1;
            continue;
          }
          progress.observed_revision = organization.revision;
          progress.last_changed_at = organization.changedAt;
          if (isDeliberateOrganizationChange(payload)) {
            progress.anchor =
              progress.anchor === null || organization.changedAt > progress.anchor
                ? organization.changedAt
                : progress.anchor;
          }
        } catch {
          progress.invalid = 1;
        }
      }
      if (events.length < ORGANIZATION_AGE_PAGE_SIZE) {
        // Live source-tagged projection updates also change provenance, so cannot be overwritten.
        yield* sql`UPDATE projection_threads SET
        organization_activity_at = CASE WHEN ${progress.invalid} = 0
          AND ${progress.observed_revision} = organization_revision
          AND ${progress.last_changed_at} = organization_changed_at
          THEN ${progress.anchor} ELSE organization_changed_at END,
        organization_age_provenance = CASE WHEN ${progress.invalid} = 0
          AND ${progress.observed_revision} = organization_revision
          AND ${progress.last_changed_at} = organization_changed_at THEN 'known' ELSE 'fallback' END
        WHERE thread_id = ${progress.thread_id} AND organization_revision = ${progress.revision}
          AND organization_age_provenance = 'pending'`;
        progress.after_thread_id = progress.thread_id;
        progress.thread_id = null;
      }
      yield* sql`UPDATE projection_organization_age_backfill SET
      after_thread_id = ${progress.after_thread_id}, thread_id = ${progress.thread_id},
      revision = ${progress.revision}, event_cursor = ${progress.event_cursor},
      observed_revision = ${progress.observed_revision}, anchor = ${progress.anchor},
      invalid = ${progress.invalid}, last_changed_at = ${progress.last_changed_at} WHERE singleton = 1`;
      return false;
    }),
  );
