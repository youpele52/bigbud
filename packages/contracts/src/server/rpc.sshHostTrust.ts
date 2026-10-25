import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS } from "../constants/websocket.constant";
import {
  ServerTrustSshHostError,
  ServerTrustSshHostInput,
  ServerTrustSshHostResult,
} from "./server.sshHostTrust";

export const WsServerTrustSshHostRpc = Rpc.make(WS_METHODS.serverTrustSshHost, {
  payload: ServerTrustSshHostInput,
  success: ServerTrustSshHostResult,
  error: ServerTrustSshHostError,
});
