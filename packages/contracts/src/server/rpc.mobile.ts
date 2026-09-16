import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  WsGitRefreshStatusRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationGetMobileThreadRpc,
  WsOrchestrationGetSnapshotRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsSubscribeOrchestrationDomainEventsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeThinkingActivityDeltasRpc,
} from "./rpc";
import {
  WsMobileRecoveryBaselineRpc,
  WsMobileRecoveryCommandOutcomeRpc,
  WsSubscribeMobileRecoveryRpc,
} from "./rpc.mobile.recovery";

export const MobileWsRpcGroup = RpcGroup.make(
  WsOrchestrationGetSnapshotRpc,
  WsOrchestrationGetMobileThreadRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsGitRefreshStatusRpc,
  WsSubscribeOrchestrationDomainEventsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeThinkingActivityDeltasRpc,
  WsMobileRecoveryBaselineRpc,
  WsMobileRecoveryCommandOutcomeRpc,
  WsSubscribeMobileRecoveryRpc,
);
