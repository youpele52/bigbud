import * as Schema from "effect/Schema";
import { CommandId, IsoDateTime, ThreadId } from "../core/baseSchemas";

const Uint = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Identity = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Section = Schema.Literals(["present", "needs-you", "later", "done"]);
export const ThreadOrganizationNativeReason = Schema.Literals([
  "attention",
  "active",
  "snooze-expired",
  "older",
  "idle",
  "target",
  // Automatic Needs you placement returned to Present once every request was answered.
  "resolved",
]);
export const ThreadOrganizationNativeOperation = Schema.Struct({
  operationId: Identity,
  occurrenceId: Identity,
  attempt: Uint,
  threadId: Identity,
  backendNonce: Identity,
  generation: Uint,
  policyVersion: Uint,
  factVersion: Uint,
  expectedRevision: Uint,
  from: Section,
  destination: Section,
  reason: ThreadOrganizationNativeReason,
  snoozeId: Schema.NullOr(Identity),
  inactivityCutoffMs: Schema.NullOr(Uint),
  createdAtMs: Uint,
  batchId: Schema.optionalKey(Identity),
});
export type ThreadOrganizationNativeOperation = typeof ThreadOrganizationNativeOperation.Type;
export const ThreadOrganizationNativeOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("applied"), resultRevision: Uint, resultSequence: Uint }),
  Schema.Struct({ status: Schema.Literal("stale") }),
  Schema.Struct({ status: Schema.Literal("not-due"), retryNotBeforeMs: Uint }),
]);
export type ThreadOrganizationNativeOutcome = typeof ThreadOrganizationNativeOutcome.Type;
/** Internal-only; the public dispatch schema never accepts native authority. */
export const ThreadOrganizationNativeCommand = Schema.Struct({
  type: Schema.Literal("thread.organization.apply"),
  commandId: CommandId,
  threadId: ThreadId,
  operation: ThreadOrganizationNativeOperation,
  createdAt: IsoDateTime,
});
export const ThreadOrganizationAutomaticMove = Schema.Struct({
  attentionWatermark: Schema.optionalKey(Uint),
  operationId: Identity,
  batchId: Schema.optionalKey(Identity),
  from: Section,
  reason: ThreadOrganizationNativeReason,
});
