import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS } from "../constants/websocket.constant";
import {
  ServerAutomationError,
  ServerAutomationResult,
  ServerCreateAutomationInput,
  ServerDeleteAutomationInput,
  ServerGetAutomationInput,
  ServerGetAutomationResult,
  ServerListAutomationRunsInput,
  ServerListAutomationRunsResult,
  ServerListAllAutomationsInput,
  ServerListAllAutomationsResult,
  ServerListAutomationsInput,
  ServerListAutomationsResult,
  ServerPauseAutomationInput,
  ServerResumeAutomationInput,
  ServerTriggerAutomationInput,
  ServerTriggerAutomationResult,
  ServerUpdateAutomationInput,
} from "./automation";

export const WsServerListAutomationsRpc = Rpc.make(WS_METHODS.serverListAutomations, {
  payload: ServerListAutomationsInput,
  success: ServerListAutomationsResult,
  error: ServerAutomationError,
});

export const WsServerListAllAutomationsRpc = Rpc.make(WS_METHODS.serverListAllAutomations, {
  payload: ServerListAllAutomationsInput,
  success: ServerListAllAutomationsResult,
  error: ServerAutomationError,
});

export const WsServerGetAutomationRpc = Rpc.make(WS_METHODS.serverGetAutomation, {
  payload: ServerGetAutomationInput,
  success: ServerGetAutomationResult,
  error: ServerAutomationError,
});

export const WsServerCreateAutomationRpc = Rpc.make(WS_METHODS.serverCreateAutomation, {
  payload: ServerCreateAutomationInput,
  success: ServerAutomationResult,
  error: ServerAutomationError,
});

export const WsServerUpdateAutomationRpc = Rpc.make(WS_METHODS.serverUpdateAutomation, {
  payload: ServerUpdateAutomationInput,
  success: ServerAutomationResult,
  error: ServerAutomationError,
});

export const WsServerPauseAutomationRpc = Rpc.make(WS_METHODS.serverPauseAutomation, {
  payload: ServerPauseAutomationInput,
  success: Schema.Void,
  error: ServerAutomationError,
});

export const WsServerResumeAutomationRpc = Rpc.make(WS_METHODS.serverResumeAutomation, {
  payload: ServerResumeAutomationInput,
  success: Schema.Void,
  error: ServerAutomationError,
});

export const WsServerDeleteAutomationRpc = Rpc.make(WS_METHODS.serverDeleteAutomation, {
  payload: ServerDeleteAutomationInput,
  success: Schema.Void,
  error: ServerAutomationError,
});

export const WsServerTriggerAutomationRpc = Rpc.make(WS_METHODS.serverTriggerAutomation, {
  payload: ServerTriggerAutomationInput,
  success: ServerTriggerAutomationResult,
  error: ServerAutomationError,
});

export const WsServerListAutomationRunsRpc = Rpc.make(WS_METHODS.serverListAutomationRuns, {
  payload: ServerListAutomationRunsInput,
  success: ServerListAutomationRunsResult,
  error: ServerAutomationError,
});
