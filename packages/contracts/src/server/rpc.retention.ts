import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";

import { ServerSettings } from "../core/settings";
import { WS_METHODS } from "../constants/websocket.constant";
import {
  ServerPreviewThreadRetentionInput,
  ServerSetThreadRetentionPolicyInput,
  ServerStartThreadRetentionInput,
  ServerThreadRetentionError,
  ServerThreadRetentionPreview,
  ServerThreadRetentionResult,
} from "./threadRetention";

export class ThreadRetentionMutationAuthorization extends RpcMiddleware.Service<ThreadRetentionMutationAuthorization>()(
  "bigbud/server/ThreadRetentionMutationAuthorization",
  { error: ServerThreadRetentionError },
) {}

export const WsServerPreviewThreadRetentionRpc = Rpc.make(WS_METHODS.serverPreviewThreadRetention, {
  payload: ServerPreviewThreadRetentionInput,
  success: ServerThreadRetentionPreview,
  error: ServerThreadRetentionError,
}).middleware(ThreadRetentionMutationAuthorization);

export const WsServerStartThreadRetentionRpc = Rpc.make(WS_METHODS.serverStartThreadRetention, {
  payload: ServerStartThreadRetentionInput,
  success: ServerThreadRetentionResult,
  error: ServerThreadRetentionError,
}).middleware(ThreadRetentionMutationAuthorization);

export const WsServerSetThreadRetentionPolicyRpc = Rpc.make(
  WS_METHODS.serverSetThreadRetentionPolicy,
  {
    payload: ServerSetThreadRetentionPolicyInput,
    success: ServerSettings,
    error: ServerThreadRetentionError,
  },
).middleware(ThreadRetentionMutationAuthorization);
