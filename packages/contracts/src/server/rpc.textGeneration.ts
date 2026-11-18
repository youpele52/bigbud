import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { EventId, ThreadId } from "../core/baseSchemas";
import { TextGenerationError } from "../workspace/git.errors";
import { WS_METHODS } from "../constants/websocket.constant";

/** Explicit consent to a new paid request, not settlement or replay of historical work. */
export const MetadataRecoveryAcknowledgement = Schema.Literal(
  "authorize-new-budget-with-unresolved-history",
);

const common = {
  threadId: ThreadId,
  operation: Schema.Literals(["title", "summary"]),
};
export const RetryThreadTextGenerationInput = Schema.Union([
  Schema.Struct({
    ...common,
    sourceActivityId: EventId,
    newRequestId: Schema.optionalKey(Schema.Never),
    acknowledgeHistoricalUncertainty: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    ...common,
    sourceActivityId: Schema.optionalKey(Schema.Never),
    /** Stable identity for one separately confirmed paid request. */
    newRequestId: EventId,
    acknowledgeHistoricalUncertainty: MetadataRecoveryAcknowledgement,
  }),
]);
export type RetryThreadTextGenerationInput = typeof RetryThreadTextGenerationInput.Type;

export const WsServerRetryTextGenerationRpc = Rpc.make(WS_METHODS.serverRetryTextGeneration, {
  payload: RetryThreadTextGenerationInput,
  success: Schema.Void,
  error: TextGenerationError,
});
