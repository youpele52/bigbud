import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS } from "../constants/websocket.constant";
import {
  ServerListRemoteFoldersError,
  ServerListRemoteFoldersInput,
  ServerListRemoteFoldersResult,
} from "./server.remoteFolders";

export const WsServerListRemoteFoldersRpc = Rpc.make(WS_METHODS.serverListRemoteFolders, {
  payload: ServerListRemoteFoldersInput,
  success: ServerListRemoteFoldersResult,
  error: ServerListRemoteFoldersError,
});
