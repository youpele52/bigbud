import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS } from "../constants/websocket.constant";
import { PeerPairingError, PeerPairingRequest, PeerPairingResult } from "./remotePeer.pairing";
import { ThreadRetentionMutationAuthorization } from "./rpc.retention";

/** Coordinator pairing administration (M6 WP-8E); owner clients only, never mobile. */
export const WsServerPeerPairingRpc = Rpc.make(WS_METHODS.serverPeerPairing, {
  payload: PeerPairingRequest,
  success: PeerPairingResult,
  error: PeerPairingError,
}).middleware(ThreadRetentionMutationAuthorization);
