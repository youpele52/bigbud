import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationGetSnapshotRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsSubscribeOrchestrationDomainEventsRpc,
  WsSubscribeThinkingActivityDeltasRpc,
} from "./rpc";

export const MobileWsRpcGroup = RpcGroup.make(
  WsOrchestrationGetSnapshotRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsSubscribeOrchestrationDomainEventsRpc,
  WsSubscribeThinkingActivityDeltasRpc,
);
