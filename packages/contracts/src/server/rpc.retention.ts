import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";

import { ServerSettings } from "../core/settings";
import { WS_METHODS } from "../constants/websocket.constant";
import {
  ServerGetThreadRetentionRunInput,
  ServerListThreadRetentionRunsInput,
  ServerListThreadRetentionRunsResult,
  ServerPreviewThreadRetentionInput,
  ServerSetThreadRetentionPolicyInput,
  ServerStartThreadRetentionInput,
  ServerThreadRetentionError,
  ServerThreadRetentionPreview,
  ServerThreadRetentionRun,
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
  success: ServerThreadRetentionRun,
  error: ServerThreadRetentionError,
}).middleware(ThreadRetentionMutationAuthorization);

export const WsServerGetThreadRetentionRunRpc = Rpc.make(WS_METHODS.serverGetThreadRetentionRun, {
  payload: ServerGetThreadRetentionRunInput,
  success: ServerThreadRetentionRun,
  error: ServerThreadRetentionError,
});

export const WsServerListThreadRetentionRunsRpc = Rpc.make(
  WS_METHODS.serverListThreadRetentionRuns,
  {
    payload: ServerListThreadRetentionRunsInput,
    success: ServerListThreadRetentionRunsResult,
    error: ServerThreadRetentionError,
  },
);

export const WsServerSetThreadRetentionPolicyRpc = Rpc.make(
  WS_METHODS.serverSetThreadRetentionPolicy,
  {
    payload: ServerSetThreadRetentionPolicyInput,
    success: ServerSettings,
    error: ServerThreadRetentionError,
  },
).middleware(ThreadRetentionMutationAuthorization);
