import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS } from "../constants/websocket.constant";
import {
  ServerListSshConfigHostsError,
  ServerListSshConfigHostsInput,
  ServerListSshConfigHostsResult,
} from "./server.sshConfig";

export const WsServerListSshConfigHostsRpc = Rpc.make(WS_METHODS.serverListSshConfigHosts, {
  payload: ServerListSshConfigHostsInput,
  success: ServerListSshConfigHostsResult,
  error: ServerListSshConfigHostsError,
});
