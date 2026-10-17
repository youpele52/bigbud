import * as Schema from "effect/Schema";

import { MessageId, ThreadId, TurnId, TrimmedNonEmptyString } from "../core/baseSchemas";

/** Immutable ownership survives runtime epochs, directory cleanup, and job retries. */
export const ProviderTurnAdmissionIdentity = Schema.Struct({
  namespace: Schema.Literals(["foreground", "learning"]),
  ownerThreadId: ThreadId,
  requestMessageId: MessageId,
});
export type ProviderTurnAdmissionIdentity = typeof ProviderTurnAdmissionIdentity.Type;

export const ProviderTurnAdmissionBinding = Schema.Struct({
  provider: TrimmedNonEmptyString,
  threadId: ThreadId,
  nativeSessionId: TrimmedNonEmptyString,
  location: TrimmedNonEmptyString,
  runtimeTargetId: TrimmedNonEmptyString,
  workspaceTargetId: TrimmedNonEmptyString,
  storageIdentity: TrimmedNonEmptyString,
});
export type ProviderTurnAdmissionBinding = typeof ProviderTurnAdmissionBinding.Type;

export const ProviderTurnAdmissionState = Schema.Literals([
  "reserved",
  "dispatch-intent",
  "accepted",
  "terminal",
]);
export type ProviderTurnAdmissionState = typeof ProviderTurnAdmissionState.Type;

export const ProviderTurnAdmission = Schema.Struct({
  ...ProviderTurnAdmissionIdentity.fields,
  binding: ProviderTurnAdmissionBinding,
  fingerprint: TrimmedNonEmptyString,
  nativeAdmissionId: TrimmedNonEmptyString,
  turnId: TurnId,
  state: ProviderTurnAdmissionState,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  finalText: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000_000))),
  terminalOutcome: Schema.optional(Schema.Literals(["completed", "failed", "interrupted"])),
});
export type ProviderTurnAdmission = typeof ProviderTurnAdmission.Type;
