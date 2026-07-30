import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { KeybindingsConfigError } from "./keybindings";
import {
  ClientOrchestrationCommand,
  OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetMobileThreadError,
  OrchestrationGetMobileThreadInput,
  OrchestrationGetSnapshotError,
  OrchestrationGetSnapshotInput,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
  ThinkingActivityDeltaEvent,
} from "../orchestration/orchestration";
import { TerminalEvent } from "../workspace/terminal";
import { ServerConfigStreamEvent, ServerLifecycleStreamEvent } from "./server";
import { ServerSettingsError } from "../core/settings";
import { WS_METHODS } from "../constants/websocket.constant";
import {
  GetProjectThreadSummariesInput,
  GetStartupProjectCatalogInput,
} from "../orchestration/orchestration.catalog";
import { GetSelectedThreadDetailInput } from "../orchestration/orchestration.detail";
import {
  OrchestrationGetProjectThreadSummariesError,
  OrchestrationGetStartupProjectCatalogError,
  OrchestrationGetSelectedThreadDetailError,
} from "../orchestration/orchestration.rpc";

export const WsOrchestrationGetStartupProjectCatalogRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getStartupProjectCatalog,
  {
    payload: GetStartupProjectCatalogInput,
    success: OrchestrationRpcSchemas.getStartupProjectCatalog.output,
    error: OrchestrationGetStartupProjectCatalogError,
  },
);

export const WsOrchestrationGetProjectThreadSummariesRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getProjectThreadSummaries,
  {
    payload: GetProjectThreadSummariesInput,
    success: OrchestrationRpcSchemas.getProjectThreadSummaries.output,
    error: OrchestrationGetProjectThreadSummariesError,
  },
);

export const WsOrchestrationGetSelectedThreadDetailRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getSelectedThreadDetail,
  {
    payload: GetSelectedThreadDetailInput,
    success: OrchestrationRpcSchemas.getSelectedThreadDetail.output,
    error: OrchestrationGetSelectedThreadDetailError,
  },
);

export const WsOrchestrationGetSnapshotRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getSnapshot, {
  payload: OrchestrationGetSnapshotInput,
  success: OrchestrationRpcSchemas.getSnapshot.output,
  error: OrchestrationGetSnapshotError,
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: OrchestrationDispatchCommandError,
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: OrchestrationGetTurnDiffError,
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: OrchestrationGetFullThreadDiffError,
  },
);

export const WsOrchestrationGetMobileThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getMobileThread,
  {
    payload: OrchestrationGetMobileThreadInput,
    success: OrchestrationRpcSchemas.getMobileThread.output,
    error: OrchestrationGetMobileThreadError,
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: OrchestrationReplayEventsError,
});

export const WsSubscribeOrchestrationDomainEventsRpc = Rpc.make(
  WS_METHODS.subscribeOrchestrationDomainEvents,
  {
    payload: Schema.Struct({}),
    success: OrchestrationEvent,
    stream: true,
  },
);

export const WsSubscribeThinkingActivityDeltasRpc = Rpc.make(
  WS_METHODS.subscribeThinkingActivityDeltas,
  {
    payload: Schema.Struct({}),
    success: ThinkingActivityDeltaEvent,
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  stream: true,
});
