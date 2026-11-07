import { ORCHESTRATION_WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";

import type { RpcUnaryMethod } from "./wsRpcClient.types";
import type { WsTransport } from "./wsTransport";

/** Bounded on-demand reads behind the thread view and project editing. */
export interface DetailPagingRpcMethods {
  readonly getTurnActivities: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnActivities>;
  readonly getMessageTextChunk: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getMessageTextChunk>;
  readonly getProjectWorktreePaths: RpcUnaryMethod<
    typeof ORCHESTRATION_WS_METHODS.getProjectWorktreePaths
  >;
}

export function createDetailPagingRpcMethods(transport: WsTransport): DetailPagingRpcMethods {
  return {
    getTurnActivities: (input) =>
      transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnActivities](input)),
    getMessageTextChunk: (input) =>
      transport.request((client) => client[ORCHESTRATION_WS_METHODS.getMessageTextChunk](input)),
    getProjectWorktreePaths: (input) =>
      transport.request((client) =>
        client[ORCHESTRATION_WS_METHODS.getProjectWorktreePaths](input),
      ),
  };
}
