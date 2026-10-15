/**
 * Delegated-thread model choice (thread orchestration Goal 11): the trunk may request a tributary
 * provider/model on `create_thread`; an unusable request falls back to the trunk's model, after an
 * optional short user pick. Schema only.
 *
 * @module orchestration.delegationModelChoice
 */
import { Schema } from "effect";

import {
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../core/baseSchemas";
import * as MessageOrigin from "./orchestration.messageOrigin";
import { ModelSelection, ProviderInteractionMode, RuntimeMode } from "./orchestration.provider";

/** The longest the delegated first turn waits for a user pick. */
export const DELEGATED_MODEL_CHOICE_HOLD_MS = 10_000;
export const DELEGATED_MODEL_CHOICE_MAX_OPTIONS = 100;

/** Activity pair on the tributary, keyed by `choiceId` (the approval.requested/.resolved pattern). */
export const DELEGATION_MODEL_CHOICE_REQUESTED_ACTIVITY_KIND = "delegation.model-choice-requested";
export const DELEGATION_MODEL_CHOICE_RESOLVED_ACTIVITY_KIND = "delegation.model-choice-resolved";

/** Lenient on provider names; whether the request is usable is decided by the server. */
export const RequestedModelSelection = Schema.Struct({
  provider: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  model: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  subProviderID: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type RequestedModelSelection = typeof RequestedModelSelection.Type;

export const ModelChoiceUnusableReason = Schema.Literals([
  "invalid-request",
  "unknown-provider",
  "provider-disabled",
  "provider-not-installed",
  "provider-unavailable",
  "provider-unauthenticated",
  "provider-hidden",
  "provider-untrusted",
  "provider-retired",
  "unsupported-execution-target",
  "unknown-model",
  "model-requires-setup",
  "agent-choice-disabled",
  "catalog-unavailable",
]);
export type ModelChoiceUnusableReason = typeof ModelChoiceUnusableReason.Type;

export const ModelChoiceOption = Schema.Struct({
  selection: ModelSelection,
  label: TrimmedNonEmptyString,
  providerLabel: TrimmedNonEmptyString,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  /** The trunk's model, used when nobody picks. */
  isFallback: Schema.Boolean,
});
export type ModelChoiceOption = typeof ModelChoiceOption.Type;

export const ModelChoiceOutcome = Schema.Literals(["requested", "fallback", "user-picked"]);
export type ModelChoiceOutcome = typeof ModelChoiceOutcome.Type;

export const ModelChoiceResolvedBy = Schema.Literals([
  "server",
  "user",
  "timeout",
  "no-client",
  "no-alternatives",
  "disabled",
  "restart-sweep",
]);
export type ModelChoiceResolvedBy = typeof ModelChoiceResolvedBy.Type;

export const DelegationModelChoiceRequested = Schema.Struct({
  choiceId: TrimmedNonEmptyString,
  delegationId: TrimmedNonEmptyString,
  /** `null` when the request could not be parsed at all. */
  requested: Schema.NullOr(RequestedModelSelection),
  fallback: ModelSelection,
  reason: ModelChoiceUnusableReason,
  options: Schema.Array(ModelChoiceOption).check(
    Schema.isMaxLength(DELEGATED_MODEL_CHOICE_MAX_OPTIONS),
  ),
  deadlineAt: IsoDateTime,
  heldMessageId: MessageId,
});
export type DelegationModelChoiceRequested = typeof DelegationModelChoiceRequested.Type;

export const DelegationModelChoiceResolved = Schema.Struct({
  choiceId: TrimmedNonEmptyString,
  requested: Schema.NullOr(RequestedModelSelection),
  fallback: ModelSelection,
  /** `null` when the requested model was usable. */
  reason: Schema.NullOr(ModelChoiceUnusableReason),
  used: ModelSelection,
  outcome: ModelChoiceOutcome,
  resolvedBy: ModelChoiceResolvedBy,
  /** The thread was archived or the held message was removed, so nothing was sent. */
  cancelled: Schema.optional(Schema.Boolean),
});
export type DelegationModelChoiceResolved = typeof DelegationModelChoiceResolved.Type;

/** Optional summary on the trunk's `delegation.child-linked` activity. */
export const DelegationModelChoiceLinkedSummary = Schema.Struct({
  requested: Schema.NullOr(RequestedModelSelection),
  status: Schema.Literals(["pending", "resolved"]),
});
export type DelegationModelChoiceLinkedSummary = typeof DelegationModelChoiceLinkedSummary.Type;

/** The delegated first message (same text and origin as an unheld `create_thread`). */
export const DelegatedFirstPrompt = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  originSegments: Schema.optional(Schema.Array(MessageOrigin.MessageOriginSegment)),
});
export type DelegatedFirstPrompt = typeof DelegatedFirstPrompt.Type;

/** Internal: queue the delegated first message and record the pending choice, atomically. */
export const ThreadDelegationModelChoiceHoldCommand = Schema.Struct({
  type: Schema.Literal("thread.delegation.model-choice.hold"),
  commandId: CommandId,
  threadId: ThreadId,
  prompt: DelegatedFirstPrompt,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  requestedActivity: Schema.Struct({
    id: EventId,
    summary: TrimmedNonEmptyString,
    payload: DelegationModelChoiceRequested,
  }),
  createdAt: IsoDateTime,
});
export type ThreadDelegationModelChoiceHoldCommand =
  typeof ThreadDelegationModelChoiceHoldCommand.Type;

/**
 * Internal: the server timer or restart sweep resolves an unanswered choice with the fallback.
 * With `fallbackStart` it is the hold-failure fallback (`resolvedBy: "server"`): it resolves a
 * committed hold like any expiry, and otherwise records the fallback and starts the message in the
 * same decision, so the delegated message is sent exactly once whatever the hold's fate.
 */
export const ThreadDelegationModelChoiceExpireCommand = Schema.Struct({
  type: Schema.Literal("thread.delegation.model-choice.expire"),
  commandId: CommandId,
  threadId: ThreadId,
  choiceId: TrimmedNonEmptyString,
  resolvedBy: Schema.Literals(["timeout", "restart-sweep", "server"]),
  fallbackStart: Schema.optional(
    Schema.Struct({
      prompt: DelegatedFirstPrompt,
      runtimeMode: RuntimeMode,
      interactionMode: ProviderInteractionMode,
      requested: DelegationModelChoiceRequested,
    }),
  ),
  createdAt: IsoDateTime,
});
export type ThreadDelegationModelChoiceExpireCommand =
  typeof ThreadDelegationModelChoiceExpireCommand.Type;

/** Client: the user picks one of the offered options; the first resolution wins. */
export const ThreadDelegationModelChoicePickCommand = Schema.Struct({
  type: Schema.Literal("thread.delegation.model-choice.pick"),
  commandId: CommandId,
  threadId: ThreadId,
  choiceId: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  createdAt: IsoDateTime,
});
export type ThreadDelegationModelChoicePickCommand =
  typeof ThreadDelegationModelChoicePickCommand.Type;
