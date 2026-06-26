import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
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

export const MobileWsRpcGroup = RpcGroup.make(
  WsOrchestrationGetSnapshotRpc,
  WsOrchestrationGetMobileThreadRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsSubscribeOrchestrationDomainEventsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeThinkingActivityDeltasRpc,
);
