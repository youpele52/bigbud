/**
 * Selected-dev peer owner adapters (T-peer / U9).
 *
 * The product peer path receives the three owner ports from the running dev SSH
 * owner session instead of launching a TypeScript `ssh`, `ssh-keygen` or
 * `ssh-keyscan`. When no session is in scope the coordinator registers with
 * typed refusals rather than a legacy fallback.
 *
 * @module peerCoordinator.owner.selected
 */
import type { PeerPairing, PeerPairingId } from "@bigbud/contracts/server/remotePeer.pairing.ts";

import type {
  PeerRelayOwnerLease,
  PeerRelayOwnerRequest,
  PeerRelaySshOwner,
} from "../remote-backend/peerRelay.ssh.owner.ts";
import { PeerRelayAdmissionError } from "../remote-backend/peerRelay.ssh.owner.ts";
import type { PeerHostKeyInspectionOwner } from "./peerCoordinator.transport.ts";
import type { PeerCoordinatorKeyMetadata, PeerCoordinatorKeyOwner } from "./peerSshKey.ts";

/** The admitted owner client methods the peer path uses. */
export interface SelectedPeerSessionClient {
  ensurePeerCoordinatorKey(): Promise<PeerCoordinatorKeyMetadata>;
  inspectPeerHostKey(
    host: string,
    port: number,
  ): Promise<{
    readonly keyType: string;
    readonly fingerprint: string;
    readonly publicKey: string;
  }>;
  openPeerRelay?(request: PeerRelayOwnerRequest, signal: AbortSignal): Promise<PeerRelayOwnerLease>;
}

export interface SelectedPeerOwnerSession {
  readonly targetId: string;
  readonly withOwner: <A>(
    executionTargetId: string,
    operation: (client: SelectedPeerSessionClient) => Promise<A>,
    signal?: AbortSignal,
  ) => Promise<A>;
}

export interface SelectedPeerOwnerAdapters {
  readonly keyOwner: PeerCoordinatorKeyOwner;
  readonly hostKeyOwner: PeerHostKeyInspectionOwner;
  /** Present only when the session exposes the paired-relay owner port. */
  readonly relayOwner: PeerRelaySshOwner | undefined;
}

/**
 * Bind the peer owner ports to one admitted coordinator-profile session. The
 * saved pairing and its coordinator fingerprint are resolved through the same
 * owner; ordinary user trust is never consulted.
 */
export function makeSelectedPeerOwnerAdapters(
  session: SelectedPeerOwnerSession,
  getPairing: (pairingId: PeerPairingId) => Promise<PeerPairing | undefined>,
): SelectedPeerOwnerAdapters {
  const keyOwner: PeerCoordinatorKeyOwner = {
    ensurePeerCoordinatorKey: () =>
      session.withOwner(session.targetId, (client) => client.ensurePeerCoordinatorKey()),
  };
  const hostKeyOwner: PeerHostKeyInspectionOwner = {
    inspectPeerHostKey: (host, port) =>
      session.withOwner(session.targetId, (client) => client.inspectPeerHostKey(host, port)),
  };
  const relayOwner: PeerRelaySshOwner = {
    resolvePeerRelayApproval: async (pairingId, signal) => {
      signal.throwIfAborted();
      const pairing = await getPairing(pairingId);
      signal.throwIfAborted();
      if (!pairing) return undefined;
      const key = await keyOwner.ensurePeerCoordinatorKey();
      signal.throwIfAborted();
      return { pairing, coordinatorKeyFingerprint: key.fingerprint };
    },
    openPeerRelay: async (request, signal) => {
      signal.throwIfAborted();
      return session.withOwner(
        session.targetId,
        (client) => {
          if (!client.openPeerRelay) throw new PeerRelayAdmissionError("authorization-refused");
          return client.openPeerRelay(request, signal);
        },
        signal,
      );
    },
  };
  return {
    keyOwner,
    hostKeyOwner,
    relayOwner,
  };
}
