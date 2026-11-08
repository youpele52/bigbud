import { ORCHESTRATION_WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";

import type { RpcUnaryMethod } from "./wsRpcClient.types";
import type { WsTransport } from "./wsTransport";

/** Server-side branches: start one, then follow its copy. */
export interface BranchCopyRpcMethods {
  readonly startThreadBranch: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.startThreadBranch>;
  readonly getThreadBranchCopy: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getThreadBranchCopy>;
}

export function createBranchCopyRpcMethods(transport: WsTransport): BranchCopyRpcMethods {
  return {
    startThreadBranch: (input) =>
      transport.request((client) => client[ORCHESTRATION_WS_METHODS.startThreadBranch](input)),
    getThreadBranchCopy: (input) =>
      transport.request((client) => client[ORCHESTRATION_WS_METHODS.getThreadBranchCopy](input)),
  };
}
