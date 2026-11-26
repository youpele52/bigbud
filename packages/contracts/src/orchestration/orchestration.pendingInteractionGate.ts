import { Schema } from "effect";
import { ApprovalRequestId, NonNegativeInt, TrimmedNonEmptyString } from "../core/baseSchemas";

import { ProviderKind } from "./orchestration.provider";

const PendingInteraction = Schema.Struct({
  requestId: ApprovalRequestId,
  generation: TrimmedNonEmptyString,
});

/** Internal dispatch fence for a provider-proven, unsent queued redelivery. */
export const PendingInteractionGate = Schema.Struct({
  provider: ProviderKind,
  sessionEpoch: NonNegativeInt,
  /** No authoritative closure is available: the user can remove, but never release, this entry. */
  manualRecovery: Schema.optional(Schema.Literal("discard-and-resend")),
  approvalRequests: Schema.Array(PendingInteraction),
  userInputRequests: Schema.Array(PendingInteraction),
});
export type PendingInteractionGate = typeof PendingInteractionGate.Type;
