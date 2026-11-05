import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { WS_METHODS } from "../constants/websocket.constant";
import { ProjectId } from "../core/baseSchemas";

export const WsServerSampleSshMonitorRpc = Rpc.make(WS_METHODS.serverSampleSshMonitor, {
  payload: Schema.Struct({ projectId: ProjectId }),
  // The monitor snapshot is already a versioned wire type on the desktop bridge.
  success: Schema.String,
  error: Schema.String,
});

export const WsServerListConnectedSshMonitorsRpc = Rpc.make(
  WS_METHODS.serverListConnectedSshMonitors,
  {
    payload: Schema.Struct({}),
    success: Schema.Array(
      Schema.Struct({ projectId: ProjectId, name: Schema.String, target: Schema.String }),
    ),
    error: Schema.String,
  },
);
