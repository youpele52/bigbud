/**
 * The event-log compaction floor: the highest sequence background maintenance may delete
 * through. Every component is "delete at most through this sequence"; the floor is their
 * minimum. All reads are sequence-only and index-backed; no baseline payload is ever read.
 *
 * Components:
 * - `baseline`: `compact_through_sequence`, capped by the newest verified baseline.
 * - `projector`: every projector cursor in `projection_state` (none recorded: nothing).
 * - `reactor`: the lowest read cursor of an open internal reactor stream. That stream dies on
 *   a replay gap (`OrchestrationEngine.domainEvents`), so it must never see one.
 * - `delivery`: the lowest sequence an open delivery session (desktop supervisor or direct
 *   web) has acknowledged; later events may still be replayed to it.
 * - `hot-window`: the newest 50,000 sequences or the last 24 hours, whichever keeps more. The
 *   24 hours are measured by the server's clock (`EventLogMaintenance.sequenceClock`) once a
 *   day-old sample exists, and by `occurred_at` until then.
 * - `cleanup`: events of open direct-cleanup intents and unfinished cleanup plans. An open intent
 *   whose plan is `blocked` does not hold it: `blocked` is terminal (nothing moves a plan out of
 *   it and no reader needs the intent's event again), so it would otherwise pin the log forever.
 * - `turn-start`: pending turn starts (`projection_threads.pending_turn_start_json`).
 * - `organization`: prepared organization operations and each thread's latest automatic move
 *   within the 7-day undo window (`ORGANIZATION_OPERATION_RETENTION`).
 * - `workspace`: in-flight project-workspace native operations and worktree operation items.
 *
 * `pinnedSinceMs` reports when a holder other than the hot window started holding the floor
 * (see `readPinnedSince`); Settings warns once that is over a day ago, whatever the backlog says.
 * Only the lowest holder is examined: a self-releasing holder (an organization undo) sitting just
 * below a longer pin hides that pin until its 7-day window ends. The `baseline` holder can pin
 * when verification keeps failing; when it merely lags (no deletions for a while), maintenance
 * verifies a new baseline itself (`EventLogMaintenance.baselineRefresh`).
 *
 * @module EventLogMaintenance.floor
 */
import type { EventLogFloorHolder } from "@bigbud/contracts/server/eventLogMaintenance.ts";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import { orchestrationSequenceFrontierSql } from "../OrchestrationSequenceFrontier.ts";
import { readSequenceClockFloor } from "./EventLogMaintenance.sequenceClock.ts";
import { ORGANIZATION_OPERATION_RETENTION } from "./ThreadOrganizationOperations.ts";

export const EVENT_LOG_HOT_WINDOW_SEQUENCES = 50_000;
export const EVENT_LOG_HOT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A floor held this long by one holder is reported as pinned. */
export const EVENT_LOG_FLOOR_PINNED_WARN_MS = 24 * 60 * 60 * 1000;
/**
 * Holders that release on their own: the hot window moves with time, and an organization move
 * is held only for its bounded 7-day undo window. Neither is reported as pinned.
 */
const SELF_RELEASING_HOLDERS: ReadonlySet<EventLogFloorHolder> = new Set([
  "hot-window",
  "organization",
]);

export interface EventLogFloorInput {
  readonly nowMs: number;
  /** Lowest open reactor stream cursor; null when none is open. */
  readonly reactorCursor: number | null;
  /** Lowest acknowledged sequence of an open delivery session; null when none is open. */
  readonly deliveryAcknowledged: number | null;
  /** Overrides the hot window (tests); defaults to 50,000 sequences or 24 hours. */
  readonly hotWindow?: { readonly sequences: number; readonly ms: number };
}

export interface EventLogFloor {
  readonly floor: number;
  readonly heldBy: EventLogFloorHolder;
  readonly head: number;
  readonly retainedThroughSequence: number;
  readonly compactThroughSequence: number;
  readonly components: Readonly<Record<EventLogFloorHolder, number | null>>;
  /** When a non-self-releasing holder began holding the floor; null when none does. */
  readonly pinnedSinceMs: number | null;
}

/** Whether the floor has been pinned for at least `EVENT_LOG_FLOOR_PINNED_WARN_MS`. */
export const isEventLogFloorPinned = (pinnedSinceMs: number | null, nowMs: number) =>
  pinnedSinceMs !== null && nowMs - pinnedSinceMs >= EVENT_LOG_FLOOR_PINNED_WARN_MS;

type NullableNumber = { readonly value: number | null };

/** Smallest component wins; on a tie the earlier (more fundamental) component is named. */
export function resolveEventLogFloor(
  components: Readonly<Record<EventLogFloorHolder, number | null>>,
  head: number,
): { readonly floor: number; readonly heldBy: EventLogFloorHolder } {
  let floor = Math.max(0, head);
  let heldBy: EventLogFloorHolder = "hot-window";
  for (const [holder, value] of Object.entries(components) as Array<
    [EventLogFloorHolder, number | null]
  >) {
    if (value === null) continue;
    const bounded = Math.max(0, Math.floor(value));
    if (bounded < floor) {
      floor = bounded;
      heldBy = holder;
    }
  }
  return { floor, heldBy };
}

/** A reference to an event at `sequence` lets maintenance delete only below it. */
const below = (sequence: number | null) => (sequence === null ? null : sequence - 1);

export const readEventLogFloor = Effect.fn("EventLogMaintenance.readFloor")(
  function* (sql: SqlClient.SqlClient, input: EventLogFloorInput) {
    const [state] = yield* sql<{
      readonly retained: number;
      readonly compact: number;
      readonly head: number;
      readonly verified: number | null;
    }>`
      SELECT
        COALESCE((SELECT retained_through_sequence FROM orchestration_retention_state
          WHERE singleton_id = 1), 0) AS "retained",
        COALESCE((SELECT compact_through_sequence FROM orchestration_retention_state
          WHERE singleton_id = 1), 0) AS "compact",
        ${orchestrationSequenceFrontierSql(sql)} AS "head",
        (SELECT MAX(sequence) FROM projection_baselines
          WHERE verification_status = 'verified') AS "verified"
    `;
    const retained = state?.retained ?? 0;
    const compact = state?.compact ?? 0;
    const head = state?.head ?? 0;
    const [projector] = yield* sql<{ readonly value: number | null; readonly count: number }>`
      SELECT MIN(last_applied_sequence) AS "value", COUNT(*) AS "count" FROM projection_state
    `;
    const hotWindowMs = input.hotWindow?.ms ?? EVENT_LOG_HOT_WINDOW_MS;
    const hotWindow = yield* readHotWindowFloor(sql, {
      head,
      retained,
      nowMs: input.nowMs,
      sequences: input.hotWindow?.sequences ?? EVENT_LOG_HOT_WINDOW_SEQUENCES,
      ms: hotWindowMs,
      clockFloor: yield* readSequenceClockFloor(sql, { nowMs: input.nowMs, windowMs: hotWindowMs }),
    });
    const [cleanup] = yield* sql<NullableNumber>`
      SELECT MIN(sequence) AS "value" FROM (
        SELECT event.sequence AS sequence FROM direct_resource_cleanup_intents AS intent
        JOIN orchestration_events AS event ON event.event_id = intent.event_id
        WHERE intent.state = 'open' AND NOT EXISTS (
          SELECT 1 FROM direct_resource_cleanup_plans AS blocked
          WHERE blocked.intent_id = intent.intent_id AND blocked.state = 'blocked'
        )
        UNION ALL
        SELECT event.sequence FROM direct_resource_cleanup_plans AS plan
        JOIN orchestration_events AS event ON event.command_id = plan.finalize_command_id
        WHERE plan.state IN ('prepared', 'ready', 'running', 'retry')
      )
    `;
    const [turnStart] = yield* sql<NullableNumber>`
      SELECT MIN(CAST(json_extract(pending_turn_start_json, '$.requestedSequence') AS INTEGER))
        AS "value"
      FROM projection_threads
      WHERE pending_turn_start_json IS NOT NULL AND json_valid(pending_turn_start_json)
    `;
    const undoCutoffMs = input.nowMs - ORGANIZATION_OPERATION_RETENTION.ageMs;
    const [organization] = yield* sql<NullableNumber>`
      SELECT MIN(sequence) AS "value" FROM (
        SELECT event.sequence AS sequence FROM thread_organization_operations AS operation
        JOIN orchestration_events AS event ON event.command_id = operation.operation_id
        WHERE operation.status = 'prepared'
        UNION ALL
        SELECT event.sequence FROM thread_organization_runtime_threads AS runtime
        JOIN thread_organization_operations AS operation
          ON operation.operation_id = runtime.latest_automatic_move_id
        JOIN orchestration_events AS event ON event.command_id = operation.operation_id
        WHERE runtime.latest_automatic_move_id IS NOT NULL
          AND operation.created_at_ms >= ${undoCutoffMs}
      )
    `;
    const [workspace] = yield* sql<NullableNumber>`
      SELECT MIN(sequence) AS "value" FROM (
        SELECT native.result_sequence AS sequence FROM project_workspace_native_operations AS native
        WHERE native.phase NOT IN ('committed', 'rejected') AND native.result_sequence IS NOT NULL
        UNION ALL
        SELECT event.sequence FROM project_workspace_native_operations AS native
        JOIN orchestration_events AS event ON event.command_id = native.command_id
        WHERE native.phase NOT IN ('committed', 'rejected')
        UNION ALL
        SELECT event.sequence FROM worktree_operation_items AS item
        JOIN worktree_operations AS operation ON operation.operation_id = item.operation_id
        JOIN orchestration_events AS event ON event.command_id = item.command_id
        WHERE operation.phase NOT IN ('completed', 'rejected')
      )
    `;
    const components: Record<EventLogFloorHolder, number | null> = {
      baseline: Math.min(compact, state?.verified ?? 0),
      projector: (projector?.count ?? 0) === 0 ? 0 : (projector?.value ?? 0),
      reactor: input.reactorCursor,
      delivery: input.deliveryAcknowledged,
      "hot-window": hotWindow,
      cleanup: below(cleanup?.value ?? null),
      "turn-start": below(turnStart?.value ?? null),
      organization: below(organization?.value ?? null),
      workspace: below(workspace?.value ?? null),
    };
    const resolved = resolveEventLogFloor(components, head);
    const pinnedSinceMs = SELF_RELEASING_HOLDERS.has(resolved.heldBy)
      ? null
      : yield* readPinnedSince(sql, {
          floor: resolved.floor,
          hotWindowMs: input.hotWindow?.ms ?? EVENT_LOG_HOT_WINDOW_MS,
          hotWindowSequences: input.hotWindow?.sequences ?? EVENT_LOG_HOT_WINDOW_SEQUENCES,
          nowMs: input.nowMs,
        });
    return {
      ...resolved,
      pinnedSinceMs,
      head,
      retainedThroughSequence: retained,
      compactThroughSequence: compact,
      components,
    } satisfies EventLogFloor;
  },
  Effect.mapError(toPersistenceSqlError("EventLogMaintenance.readFloor")),
);

/**
 * The oldest kept event is the one just above the floor. Without the holder it would have become
 * deletable once both hot windows released it: 24 hours after it occurred, and once the head
 * moved 50,000 sequences past it (the occurrence time of that later event). The holder has pinned
 * it since the later of the two. Derived from stored data on every read, so it survives restarts
 * without its own column. Two primary-key probes.
 */
const readPinnedSince = Effect.fn("EventLogMaintenance.readPinnedSince")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly floor: number;
    readonly hotWindowMs: number;
    readonly hotWindowSequences: number;
    readonly nowMs: number;
  },
) {
  const firstAtOrAfter = (sequence: number) =>
    sql<{ readonly occurredAt: string }>`
      SELECT occurred_at AS "occurredAt" FROM orchestration_events
      WHERE sequence >= ${sequence} ORDER BY sequence ASC LIMIT 1
    `.pipe(
      Effect.map((rows) => (rows[0] === undefined ? Number.NaN : Date.parse(rows[0].occurredAt))),
    );
  const oldestMs = yield* firstAtOrAfter(input.floor + 1);
  // Nothing above the floor yet, or the head has not moved 50,000 sequences past it.
  const sequenceReleaseMs = yield* firstAtOrAfter(input.floor + 1 + input.hotWindowSequences);
  if (!Number.isFinite(oldestMs) || !Number.isFinite(sequenceReleaseMs)) return null;
  const since = Math.max(oldestMs + input.hotWindowMs, sequenceReleaseMs);
  return since <= input.nowMs ? since : null;
});

/**
 * Keeps the newest 50,000 sequences or the last 24 hours, whichever keeps more. With a day-old
 * sequence-clock sample (`clockFloor`) the 24 hours come from the server's clock and no event
 * is read. Otherwise usually one primary-key probe; when the 50,000th-newest event is itself
 * younger than 24 hours by `occurred_at`, a binary search over sequence (about 23 probes) finds
 * the 24-hour boundary.
 */
const readHotWindowFloor = Effect.fn("EventLogMaintenance.readHotWindowFloor")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly head: number;
    readonly retained: number;
    readonly nowMs: number;
    readonly sequences: number;
    readonly ms: number;
    /** Head of the newest server-clock sample at least `ms` old; null when none is. */
    readonly clockFloor: number | null;
  },
) {
  const bySequence = Math.max(0, input.head - input.sequences);
  if (input.clockFloor !== null) return Math.max(0, Math.min(bySequence, input.clockFloor));
  const cutoff = new Date(input.nowMs - input.ms).toISOString();
  const firstAtOrAfter = (sequence: number) =>
    sql<{ readonly sequence: number; readonly occurredAt: string }>`
      SELECT sequence, occurred_at AS "occurredAt" FROM orchestration_events
      WHERE sequence >= ${sequence} ORDER BY sequence ASC LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]));
  const boundary = yield* firstAtOrAfter(bySequence + 1);
  // No event inside the sequence window, or its oldest event is already over 24 hours old.
  if (boundary === undefined || boundary.occurredAt < cutoff) return bySequence;
  // `firstYoung` is the oldest event known to be inside 24 hours; candidates are [low, high).
  let firstYoung = boundary.sequence;
  let low = Math.max(0, input.retained) + 1;
  let high = boundary.sequence;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const probe = yield* firstAtOrAfter(middle);
    if (probe === undefined || probe.sequence >= high) {
      high = middle;
    } else if (probe.occurredAt < cutoff) {
      low = probe.sequence + 1;
    } else {
      firstYoung = probe.sequence;
      high = probe.sequence;
    }
  }
  return Math.max(0, Math.min(bySequence, firstYoung - 1));
});
