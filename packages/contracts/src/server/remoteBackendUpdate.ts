import * as Schema from "effect/Schema";

/**
 * Remote backend runtime update (M3 WP-4C, D9/D10). Schema only.
 *
 * One serialized update operation exists at a time; concurrent setup-authority requests join it.
 * Interruption consent is separate from the request (D9) and bound to the operation id plus a
 * digest of the affected-work list the client was shown.
 */
const Uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export const RemoteRuntimeUpdateOperationId = Schema.String.check(Schema.isPattern(Uuid));
export type RemoteRuntimeUpdateOperationId = typeof RemoteRuntimeUpdateOperationId.Type;

/** Caller nonce: a retried request with the same id returns the operation it created. */
export const RemoteRuntimeUpdateRequestId = Schema.String.check(Schema.isPattern(Uuid));

/** Same shape as the signed backend graph manifest version. */
export const RemoteRuntimeUpdateVersion = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/),
);

/** Where the new graph comes from (D5): signed release asset, laptop upload or dev override. */
export const RemoteRuntimeUpdateSource = Schema.Literals([
  "release",
  "laptop-upload",
  "local-graph",
]);
export type RemoteRuntimeUpdateSource = typeof RemoteRuntimeUpdateSource.Type;

/**
 * pending → staging → staged → awaiting-drain → activating → activated, plus deferred (blocking
 * work remains; returns to awaiting-drain), failed and cancelled. activated, failed and cancelled
 * are terminal. WP-4C stops at staged/awaiting-drain; drain and activation are WP-4D.
 */
export const RemoteRuntimeUpdateState = Schema.Literals([
  "pending",
  "staging",
  "staged",
  "awaiting-drain",
  "deferred",
  "activating",
  "activated",
  "failed",
  "cancelled",
]);
export type RemoteRuntimeUpdateState = typeof RemoteRuntimeUpdateState.Type;

export const RemoteRuntimeUpdateConsentState = Schema.Literals(["none", "recorded", "consumed"]);
export type RemoteRuntimeUpdateConsentState = typeof RemoteRuntimeUpdateConsentState.Type;

const Sha256Hex = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

/** Work an interrupting update would stop. Independent Rust terminals are never listed. */
export const RemoteRuntimeUpdateAffectedWork = Schema.Struct({
  kind: Schema.Literals(["turn", "approval", "user-input", "shell", "other"]),
  id: Label,
  label: Label,
});
export type RemoteRuntimeUpdateAffectedWork = typeof RemoteRuntimeUpdateAffectedWork.Type;

export const RemoteRuntimeUpdateOperation = Schema.Struct({
  operationId: RemoteRuntimeUpdateOperationId,
  version: RemoteRuntimeUpdateVersion,
  source: RemoteRuntimeUpdateSource,
  state: RemoteRuntimeUpdateState,
  /** The caller asked for an interrupting update; this is never consent by itself. */
  interruptRequested: Schema.Boolean,
  consent: RemoteRuntimeUpdateConsentState,
  failure: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024))),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type RemoteRuntimeUpdateOperation = typeof RemoteRuntimeUpdateOperation.Type;

export const RemoteRuntimeUpdateRequestInput = Schema.Struct({
  requestId: RemoteRuntimeUpdateRequestId,
  version: RemoteRuntimeUpdateVersion,
  source: RemoteRuntimeUpdateSource,
  /** Ask for an interrupting update. Activation still needs separate interruption consent. */
  interrupt: Schema.Boolean,
});
export type RemoteRuntimeUpdateRequestInput = typeof RemoteRuntimeUpdateRequestInput.Type;

export const RemoteRuntimeUpdateRequestResult = Schema.Struct({
  /** created: this request started it; joined: same target; conflict: a different update runs. */
  disposition: Schema.Literals(["created", "joined", "conflict"]),
  operation: RemoteRuntimeUpdateOperation,
});
export type RemoteRuntimeUpdateRequestResult = typeof RemoteRuntimeUpdateRequestResult.Type;

export const RemoteRuntimeUpdateStatusInput = Schema.Struct({
  /** Omitted: the live operation, else the most recent one. */
  operationId: Schema.optional(RemoteRuntimeUpdateOperationId),
});
export type RemoteRuntimeUpdateStatusInput = typeof RemoteRuntimeUpdateStatusInput.Type;

export const RemoteRuntimeUpdateStatus = Schema.Struct({
  operation: Schema.NullOr(RemoteRuntimeUpdateOperation),
  /** Current affected work and its operation-bound digest; consent must name this digest. */
  affectedWork: Schema.Array(RemoteRuntimeUpdateAffectedWork),
  affectedWorkDigest: Schema.NullOr(Sha256Hex),
});
export type RemoteRuntimeUpdateStatus = typeof RemoteRuntimeUpdateStatus.Type;

export const RemoteRuntimeUpdateConsentInput = Schema.Struct({
  operationId: RemoteRuntimeUpdateOperationId,
  affectedWorkDigest: Sha256Hex,
});
export type RemoteRuntimeUpdateConsentInput = typeof RemoteRuntimeUpdateConsentInput.Type;

export const RemoteRuntimeUpdateCancelInput = Schema.Struct({
  operationId: RemoteRuntimeUpdateOperationId,
});
export type RemoteRuntimeUpdateCancelInput = typeof RemoteRuntimeUpdateCancelInput.Type;

export const RemoteRuntimeUpdateErrorCode = Schema.Literals([
  "unauthorized",
  "unavailable",
  "not-found",
  "invalid-state",
  "consent-stale",
  "consent-reused",
  "consent-required",
  "staging-failed",
]);
export type RemoteRuntimeUpdateErrorCode = typeof RemoteRuntimeUpdateErrorCode.Type;

export class RemoteRuntimeUpdateError extends Schema.TaggedErrorClass<RemoteRuntimeUpdateError>()(
  "RemoteRuntimeUpdateError",
  { code: RemoteRuntimeUpdateErrorCode, message: Schema.String },
) {}
