import * as Rpc from "effect/unstable/rpc/Rpc";

import { ORCHESTRATION_WS_METHODS } from "../constants/websocket.constant";
import {
  GetThreadBranchCopyInput,
  GetThreadBranchCopyResult,
  OrchestrationGetThreadBranchCopyError,
  OrchestrationStartThreadBranchError,
  StartThreadBranchInput,
  ThreadBranchCopyStatus,
} from "../orchestration/orchestration.branchCopy";

export const WsOrchestrationStartThreadBranchRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.startThreadBranch,
  {
    payload: StartThreadBranchInput,
    success: ThreadBranchCopyStatus,
    error: OrchestrationStartThreadBranchError,
  },
);

export const WsOrchestrationGetThreadBranchCopyRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getThreadBranchCopy,
  {
    payload: GetThreadBranchCopyInput,
    success: GetThreadBranchCopyResult,
    error: OrchestrationGetThreadBranchCopyError,
  },
);
