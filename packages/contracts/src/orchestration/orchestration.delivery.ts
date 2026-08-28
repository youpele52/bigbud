import { Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "../core/baseSchemas";
import { OrchestrationEvent } from "./orchestration.events";

export const OrchestrationDeliveryRoute = Schema.Literals([
  "direct-unmanaged",
  "supervisor",
  "fallback-fenced",
]);
export type OrchestrationDeliveryRoute = typeof OrchestrationDeliveryRoute.Type;

export const OrchestrationDeliveryLifecycleState = Schema.Literals([
  "connecting",
  "live",
  "reconnecting",
  "degraded",
  "incompatible",
  "fallback",
]);
export type OrchestrationDeliveryLifecycleState = typeof OrchestrationDeliveryLifecycleState.Type;

export const OrchestrationDeliveryRecoveryReason = Schema.Literals([
  "replay_budget_exceeded",
  "replay_unavailable",
]);
export type OrchestrationDeliveryRecoveryReason = typeof OrchestrationDeliveryRecoveryReason.Type;

export const OrchestrationDeliverySubscriptionInput = Schema.Struct({
  consumerId: Schema.optional(TrimmedNonEmptyString),
  appliedSequence: Schema.optional(NonNegativeInt),
});
export type OrchestrationDeliverySubscriptionInput =
  typeof OrchestrationDeliverySubscriptionInput.Type;

export const OrchestrationDeliveryBatch = Schema.Struct({
  type: Schema.Literal("batch"),
  route: OrchestrationDeliveryRoute,
  consumerId: TrimmedNonEmptyString,
  consumerGeneration: NonNegativeInt,
  serverEpoch: TrimmedNonEmptyString,
  subscriptionGeneration: NonNegativeInt,
  batchId: TrimmedNonEmptyString,
  events: Schema.Array(OrchestrationEvent),
});
export type OrchestrationDeliveryBatch = typeof OrchestrationDeliveryBatch.Type;

export const OrchestrationDeliveryLifecycle = Schema.Struct({
  type: Schema.Literal("lifecycle"),
  route: OrchestrationDeliveryRoute,
  consumerId: TrimmedNonEmptyString,
  consumerGeneration: NonNegativeInt,
  state: OrchestrationDeliveryLifecycleState,
  acknowledgedSequence: NonNegativeInt,
  restartAttempt: NonNegativeInt,
  reasonCode: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationDeliveryLifecycle = typeof OrchestrationDeliveryLifecycle.Type;

export const OrchestrationDeliveryRecovery = Schema.Struct({
  type: Schema.Literal("recovery"),
  route: OrchestrationDeliveryRoute,
  recoveryId: TrimmedNonEmptyString,
  consumerId: TrimmedNonEmptyString,
  consumerGeneration: NonNegativeInt,
  serverEpoch: TrimmedNonEmptyString,
  acknowledgedSequence: NonNegativeInt,
  targetSequence: NonNegativeInt,
  reasonCode: OrchestrationDeliveryRecoveryReason,
});
export type OrchestrationDeliveryRecovery = typeof OrchestrationDeliveryRecovery.Type;

export const OrchestrationDeliveryStreamItem = Schema.Union([
  OrchestrationDeliveryBatch,
  OrchestrationDeliveryLifecycle,
  OrchestrationDeliveryRecovery,
]);
export type OrchestrationDeliveryStreamItem = typeof OrchestrationDeliveryStreamItem.Type;

export const OrchestrationApplicationAckInput = Schema.Struct({
  batchId: TrimmedNonEmptyString,
  consumerId: TrimmedNonEmptyString,
  consumerGeneration: NonNegativeInt,
  receivedThroughSequence: NonNegativeInt,
  appliedThroughSequence: NonNegativeInt,
  applicationDurationMs: NonNegativeInt,
});
export type OrchestrationApplicationAckInput = typeof OrchestrationApplicationAckInput.Type;

export const OrchestrationApplicationAckResult = Schema.Struct({
  accepted: Schema.Boolean,
  fenced: Schema.Boolean,
  acknowledgedSequence: NonNegativeInt,
});
export type OrchestrationApplicationAckResult = typeof OrchestrationApplicationAckResult.Type;

export const OrchestrationBaselineAckInput = Schema.Struct({
  recoveryId: TrimmedNonEmptyString,
  consumerId: TrimmedNonEmptyString,
  consumerGeneration: NonNegativeInt,
  serverEpoch: TrimmedNonEmptyString,
  appliedProjectionSequence: NonNegativeInt,
  applicationDurationMs: NonNegativeInt,
});
export type OrchestrationBaselineAckInput = typeof OrchestrationBaselineAckInput.Type;

export const OrchestrationBaselineAckResult = Schema.Struct({
  accepted: Schema.Boolean,
  fenced: Schema.Boolean,
  acknowledgedSequence: NonNegativeInt,
});
export type OrchestrationBaselineAckResult = typeof OrchestrationBaselineAckResult.Type;
