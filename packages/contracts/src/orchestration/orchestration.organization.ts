import { Schema } from "effect";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";

/**
 * Inyosira organization of a thread. It is independent of the provider's runtime status: moving a
 * thread never starts, stops, archives, or answers anything.
 */
export const THREAD_ORGANIZATION_STATES = ["present", "needs-you", "later", "done"] as const;
export const ThreadOrganizationState = Schema.Literals(THREAD_ORGANIZATION_STATES);
export type ThreadOrganizationState = typeof ThreadOrganizationState.Type;

export const THREAD_SNOOZE_MIN_MINUTES = 2;
export const THREAD_SNOOZE_MAX_MINUTES = 24 * 60;
export const ThreadSnoozeMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: THREAD_SNOOZE_MIN_MINUTES, maximum: THREAD_SNOOZE_MAX_MINUTES }),
);
export type ThreadSnoozeMinutes = typeof ThreadSnoozeMinutes.Type;

/** A snooze occurrence. `id` identifies this deadline so a stale timer cannot fire a newer one. */
export const ThreadOrganizationSnooze = Schema.Struct({
  id: TrimmedNonEmptyString,
  until: IsoDateTime,
});
export type ThreadOrganizationSnooze = typeof ThreadOrganizationSnooze.Type;

/**
 * `revision` grows with every accepted organization change and fences stale actions.
 * `changedAt` is null for threads that were never organized.
 */
export const ThreadOrganization = Schema.Struct({
  state: ThreadOrganizationState,
  revision: NonNegativeInt,
  changedAt: Schema.NullOr(IsoDateTime),
  snooze: Schema.NullOr(ThreadOrganizationSnooze),
});
export type ThreadOrganization = typeof ThreadOrganization.Type;

export const DEFAULT_THREAD_ORGANIZATION: ThreadOrganization = {
  state: "present",
  revision: 0,
  changedAt: null,
  snooze: null,
};

/** Read-model field: absent on snapshots and rows written before Inyosira existed. */
export const ThreadOrganizationField = Schema.optional(ThreadOrganization).pipe(
  Schema.withDecodingDefault(() => DEFAULT_THREAD_ORGANIZATION),
);

/** Client command: move a thread to a state. Any move replaces an existing snooze. */
export const ThreadOrganizationMoveCommand = Schema.Struct({
  type: Schema.Literal("thread.organization.move"),
  commandId: CommandId,
  threadId: ThreadId,
  state: ThreadOrganizationState,
  /** The revision the caller saw. When present and stale, the server refuses the move. */
  expectedRevision: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type ThreadOrganizationMoveCommand = typeof ThreadOrganizationMoveCommand.Type;

/** Client command: put a thread in Later until the server-calculated deadline. */
export const ThreadOrganizationSnoozeCommand = Schema.Struct({
  type: Schema.Literal("thread.organization.snooze"),
  commandId: CommandId,
  threadId: ThreadId,
  durationMinutes: ThreadSnoozeMinutes,
  createdAt: IsoDateTime,
});
export type ThreadOrganizationSnoozeCommand = typeof ThreadOrganizationSnoozeCommand.Type;

/**
 * Internal command: a snooze deadline passed. It applies only while `snoozeId` is still the
 * thread's snooze and its deadline has passed, so a stale or duplicate timer changes nothing.
 */
export const ThreadOrganizationSnoozeExpireCommand = Schema.Struct({
  type: Schema.Literal("thread.organization.snooze.expire"),
  commandId: CommandId,
  threadId: ThreadId,
  snoozeId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type ThreadOrganizationSnoozeExpireCommand =
  typeof ThreadOrganizationSnoozeExpireCommand.Type;

/**
 * Internal command: idle cleanup of a Present or Later thread. It applies only while the thread
 * is still in `fromState` at `expectedRevision`, unsnoozed, live, and quiescent when decided.
 */
export const ThreadOrganizationIdleCommand = Schema.Struct({
  type: Schema.Literal("thread.organization.idle"),
  commandId: CommandId,
  threadId: ThreadId,
  expectedRevision: NonNegativeInt,
  fromState: Schema.Literals(["present", "later"]).pipe(
    Schema.withDecodingDefault(() => "present" as const),
  ),
  destination: Schema.Literals(["done", "later"]),
  createdAt: IsoDateTime,
});
export type ThreadOrganizationIdleCommand = typeof ThreadOrganizationIdleCommand.Type;

export const ThreadOrganizationChangeReason = Schema.Literals([
  "move",
  "snooze",
  "snooze-expired",
  "idle",
  "archive",
  "unarchive",
]);
export type ThreadOrganizationChangeReason = typeof ThreadOrganizationChangeReason.Type;

/**
 * `thread.organization-updated` payload. It carries the complete resulting organization, so
 * replay applies recorded values and never consults the clock. It does not change the thread's
 * `updatedAt`: organizing a thread is not activity.
 */
export const ThreadOrganizationUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  organization: ThreadOrganization,
  reason: ThreadOrganizationChangeReason,
});
export type ThreadOrganizationUpdatedPayload = typeof ThreadOrganizationUpdatedPayload.Type;
