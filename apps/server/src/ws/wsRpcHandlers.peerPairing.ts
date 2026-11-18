import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import {
  PeerPairingError,
  type PeerPairingRequest,
} from "@bigbud/contracts/server/remotePeer.pairing.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { getPeerCoordinator } from "../peer-orchestration/peerCoordinator.layer.ts";
import { handlePeerPairingRequest } from "../peer-orchestration/peerPairing.ts";

/**
 * Coordinator pairing RPC (M6 WP-8E). Owner clients only (the retention mutation middleware); the
 * coordinator registers in remote mode, so a local backend answers `unavailable`.
 */
export function makeWsRpcPeerPairingHandlers() {
  return {
    [WS_METHODS.serverPeerPairing]: (input: PeerPairingRequest) => {
      const coordinator = getPeerCoordinator();
      if (!coordinator)
        return Effect.fail(
          new PeerPairingError({
            code: "unavailable",
            message: "Peer pairing is only available on a remote backend coordinator.",
          }),
        );
      return handlePeerPairingRequest(coordinator.pairing, input).pipe(
        Effect.mapError((error) =>
          Schema.is(PeerPairingError)(error)
            ? error
            : new PeerPairingError({ code: "unavailable", message: "Pairing storage failed." }),
        ),
      );
    },
  };
}
