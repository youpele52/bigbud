import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { EventId, ThreadId } from "../core/baseSchemas";
import { TextGenerationError } from "../workspace/git.errors";
import { WS_METHODS } from "../constants/websocket.constant";

export const RetryThreadTextGenerationInput = Schema.Struct({
  threadId: ThreadId,
  sourceActivityId: EventId,
  operation: Schema.Literals(["title", "summary"]),
});
export type RetryThreadTextGenerationInput = typeof RetryThreadTextGenerationInput.Type;

export const WsServerRetryTextGenerationRpc = Rpc.make(WS_METHODS.serverRetryTextGeneration, {
  payload: RetryThreadTextGenerationInput,
  success: Schema.Void,
  error: TextGenerationError,
});
