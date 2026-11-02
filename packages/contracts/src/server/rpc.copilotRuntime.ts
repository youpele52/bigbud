import * as Rpc from "effect/unstable/rpc/Rpc";
import { WS_METHODS } from "../constants/websocket.constant";
import { CopilotRuntimeError, CopilotRuntimeInput, CopilotRuntimeState } from "./copilotRuntime";
import { ThreadRetentionMutationAuthorization } from "./rpc.retention";

export const WsCopilotRuntimeRpc = Rpc.make(WS_METHODS.serverCopilotRuntime, {
  payload: CopilotRuntimeInput,
  success: CopilotRuntimeState,
  error: CopilotRuntimeError,
}).middleware(ThreadRetentionMutationAuthorization);
