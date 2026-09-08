import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS } from "../constants/websocket.constant";
import {
  ServerGetRemoteAgentUpdateStatusError,
  ServerGetRemoteAgentUpdateStatusInput,
  ServerRemoteAgentUpdateStatus,
} from "./server";

export const WsServerGetRemoteAgentUpdateStatusRpc = Rpc.make(
  WS_METHODS.serverGetRemoteAgentUpdateStatus,
  {
    payload: ServerGetRemoteAgentUpdateStatusInput,
    success: ServerRemoteAgentUpdateStatus,
    error: ServerGetRemoteAgentUpdateStatusError,
  },
);
