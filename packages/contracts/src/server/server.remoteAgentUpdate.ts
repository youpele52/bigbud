import { Schema } from "effect";

import { ExecutionTargetId, TrimmedNonEmptyString } from "../core/baseSchemas";

/** Persisted update preparation and reconnect status for one remote agent target. */
export const ServerRemoteAgentUpdateStatusPhase = Schema.Literals([
  "idle",
  "waiting-for-authentication",
  "capacity-noncompliant",
  "reserved",
  "installing",
  "checking-health",
  "ready-for-next-reconnect",
  "waiting-for-capacity",
  "failed-using-stable",
  "verification-unavailable",
  "connected",
]);
export type ServerRemoteAgentUpdateStatusPhase = typeof ServerRemoteAgentUpdateStatusPhase.Type;

export const ServerRemoteAgentUpdateStatus = Schema.Struct({
  executionTargetId: ExecutionTargetId,
  phase: ServerRemoteAgentUpdateStatusPhase,
  updateRequestId: Schema.NullOr(TrimmedNonEmptyString),
  reconnectRequestId: Schema.NullOr(TrimmedNonEmptyString),
  reconnectOutcome: Schema.NullOr(Schema.Literals(["pending", "selected", "fallback", "rejected"])),
  currentVersion: Schema.NullOr(TrimmedNonEmptyString),
  pendingVersion: Schema.NullOr(TrimmedNonEmptyString),
  predecessorVersion: Schema.NullOr(TrimmedNonEmptyString),
  reason: Schema.NullOr(TrimmedNonEmptyString),
  /** Target triple and short SHA-256 tell apart builds of one version (for example musl and gnu). */
  currentTargetTriple: Schema.optional(TrimmedNonEmptyString),
  currentBuildDigestShort: Schema.optional(TrimmedNonEmptyString),
  pendingTargetTriple: Schema.optional(TrimmedNonEmptyString),
  pendingBuildDigestShort: Schema.optional(TrimmedNonEmptyString),
});
export type ServerRemoteAgentUpdateStatus = typeof ServerRemoteAgentUpdateStatus.Type;
