import * as Rpc from "effect/unstable/rpc/Rpc";
import { WS_METHODS } from "../constants/websocket.constant";
import {
  ServerOpencodeV2ThreadToolsSetupInput,
  ServerOpencodeV2ThreadToolsSetupResult,
} from "./server.opencodeV2ThreadToolsSetup";

export const WsServerOpencodeV2ThreadToolsSetupRpc = Rpc.make(
  WS_METHODS.serverGetOpencodeV2ThreadToolsSetup,
  {
    payload: ServerOpencodeV2ThreadToolsSetupInput,
    success: ServerOpencodeV2ThreadToolsSetupResult,
  },
);
