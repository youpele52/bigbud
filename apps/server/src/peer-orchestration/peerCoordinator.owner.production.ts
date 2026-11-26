/**
 * U24 production peer owner adapters (W2 T-peer, U9).
 *
 * Under `SSH_OWNER_PRODUCTION_ACTIVATION` the live production owner holds the
 * pairing authority: it provisions the coordinator key, inspects a worker's
 * presented key with a one-time challenge, writes a pin only when that
 * challenge is approved, and opens relay channels that name nothing but the
 * pairing id. The server keeps the latest challenge per endpoint only until
 * the user confirms (or re-scans); it never sends a host, key or user to a
 * relay. Without a live owner every port refuses; there is no fallback.
 *
 * @module peerCoordinator.owner.production
 */
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import { PassThrough } from "node:stream";

import type { PeerPairing, PeerPairingId } from "@bigbud/contracts/server/remotePeer.pairing.ts";

import type {
  PeerRelayOwnerExit,
  PeerRelayOwnerLease,
  PeerRelaySshOwner,
} from "../remote-backend/peerRelay.ssh.owner.ts";
import { PeerRelayAdmissionError } from "../remote-backend/peerRelay.ssh.owner.ts";
import type { PickerProofPeerProductionClient } from "../ssh/sshOwnerPickerProof.client.peerProduction.ts";
import type { PeerRelayState } from "../ssh/sshOwnerPickerProof.codec.peerProduction.ts";
import { PickerProofOwnerError } from "../ssh/sshOwnerPickerProof.codec.wire.ts";
import type { SshOwnerProductionRegistration } from "../ssh/sshOwnerProductionRegistry.ts";
import {
  sshHostKeyFingerprint,
  type PeerHostKeyInspectionOwner,
} from "./peerCoordinator.transport.ts";
import { PeerEnrollmentOwnerUnavailableError, type PeerCoordinatorKeyOwner } from "./peerSshKey.ts";

/** Challenges outlive a scan only until the owner's own 300 s expiry. */
const CHALLENGE_MS = 290_000;
const CLOSE_TIMEOUT_MS = 2_000;
/** The production key is bound to the owner's own profile state, not a dev session. */
const PRODUCTION_BINDING = new TextEncoder().encode("ssh-owner-production");

export interface ProductionPeerOwnerAdapters {
  readonly keyOwner: PeerCoordinatorKeyOwner;
  readonly hostKeyOwner: PeerHostKeyInspectionOwner;
  readonly relayOwner: PeerRelaySshOwner;
  /** Approve the scanned challenge for exactly this confirmed pin. */
  readonly approvePin: (input: {
    readonly pairingId: string;
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly pinnedHostKey: string;
  }) => Promise<void>;
  /** Remove the owner pin and reap that pairing's channels. Unknown is not an error. */
  readonly revokePin: (pairingId: string) => Promise<void>;
}

export interface ProductionPeerOwnerDependencies {
  readonly owner: () => SshOwnerProductionRegistration | undefined;
  readonly getPairing: (pairingId: PeerPairingId) => Promise<PeerPairing | undefined>;
  readonly pollMs?: { readonly first: number; readonly max: number; readonly limit: number };
}

function connectSocket(path: string, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path, allowHalfOpen: true });
    const abort = () => socket.destroy(signal.reason as Error);
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => {
      signal.removeEventListener("abort", abort);
      resolve(socket);
    });
    socket.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

function exitOf(state: PeerRelayState): PeerRelayOwnerExit | undefined {
  switch (state.phase) {
    case "exited":
      return { kind: "exited", code: state.exitCode };
    case "closed":
    case "lost":
      return { kind: "signaled", signal: "SIGKILL" };
    case "unconfirmed":
      throw new Error("The SSH owner could not confirm the peer relay channel's exit.");
    default:
      return undefined;
  }
}

/** A refused open is a settled setup outcome on an already-ended stream. */
function refusedLease(reason: "host-identity-mismatch" | "authentication-refused") {
  const stream = new PassThrough();
  stream.end();
  return {
    stream,
    exit: Promise.resolve<PeerRelayOwnerExit>({ kind: "setup-refused", reason }),
    cancel: () => undefined,
  } satisfies PeerRelayOwnerLease;
}

export function makeProductionPeerOwnerAdapters(
  dependencies: ProductionPeerOwnerDependencies,
): ProductionPeerOwnerAdapters {
  const poll = dependencies.pollMs ?? { first: 20, max: 500, limit: 40 };
  const challenges = new Map<
    string,
    { readonly challenge: Uint8Array; readonly publicKey: string; readonly at: number }
  >();
  const peer = (): PickerProofPeerProductionClient => {
    const client = dependencies.owner()?.handle.peer;
    if (!client)
      throw new PeerEnrollmentOwnerUnavailableError("The SSH owner is not running for peer work.");
    return client;
  };
  const keyOwner: PeerCoordinatorKeyOwner = {
    async ensurePeerCoordinatorKey() {
      const key = await peer().ensureCoordinatorKey();
      return { ...key, profileBinding: PRODUCTION_BINDING };
    },
  };
  const hostKeyOwner: PeerHostKeyInspectionOwner = {
    async inspectPeerHostKey(host, port) {
      const key = await peer().inspectHostKey(host, port);
      challenges.set(`${host}:${port}`, {
        challenge: key.challenge,
        publicKey: key.publicKey,
        at: Date.now(),
      });
      return { keyType: key.keyType, fingerprint: key.fingerprint, publicKey: key.publicKey };
    },
  };
  const settle = async (client: PickerProofPeerProductionClient, lease: Uint8Array) => {
    let wait = poll.first;
    for (let attempt = 0; attempt < poll.limit; attempt++) {
      const exit = exitOf(await client.relayStatus(lease));
      if (exit) return exit;
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, poll.max);
    }
    const closed = exitOf(await client.closeRelay(lease));
    if (closed) return closed;
    throw new Error("The SSH owner did not settle the peer relay channel.");
  };
  const relayOwner: PeerRelaySshOwner = {
    async resolvePeerRelayApproval(pairingId, signal) {
      signal.throwIfAborted();
      const pairing = await dependencies.getPairing(pairingId);
      signal.throwIfAborted();
      if (!pairing) return undefined;
      const key = await keyOwner.ensurePeerCoordinatorKey();
      return { pairing, coordinatorKeyFingerprint: key.fingerprint };
    },
    async openPeerRelay(request, signal) {
      signal.throwIfAborted();
      const client = peer();
      const lease = randomBytes(32);
      let state: PeerRelayState;
      try {
        state = await client.openRelay(lease, request.pairing.pairingId);
      } catch (error) {
        if (error instanceof PickerProofOwnerError) {
          if (error.code === "peerPinMismatch") return refusedLease("host-identity-mismatch");
          if (error.code === "peerAuthRefused") return refusedLease("authentication-refused");
          if (error.code === "peerPinUnknown")
            throw new PeerRelayAdmissionError("authorization-refused");
        }
        throw error;
      }
      const close = () =>
        Promise.race([
          client.closeRelay(lease).then(
            () => undefined,
            () => undefined,
          ),
          new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
        ]).then(() => undefined);
      let socket: Socket;
      try {
        if (state.phase !== "listening") throw new Error("The peer relay channel did not listen.");
        socket = await connectSocket(state.socketPath, signal);
      } catch (error) {
        await close();
        throw error;
      }
      socket.on("error", () => {});
      const ended = new Promise<void>((resolve) => {
        socket.once("end", () => resolve());
        socket.once("close", () => resolve());
      });
      const exit = ended.then(() => settle(client, lease));
      void exit.catch(() => {});
      return {
        stream: socket,
        exit,
        cancel: async () => {
          await close();
          socket.destroy();
        },
      };
    },
  };
  return {
    keyOwner,
    hostKeyOwner,
    relayOwner,
    async approvePin({ pairingId, host, port, user, pinnedHostKey }) {
      const key = `${host}:${port}`;
      const scanned = challenges.get(key);
      challenges.delete(key);
      if (!scanned || scanned.publicKey !== pinnedHostKey || Date.now() - scanned.at > CHALLENGE_MS)
        throw new Error("Re-scan the worker's host key, then confirm the pin; nothing was saved.");
      const pin = await peer().approvePin(scanned.challenge, pairingId, user);
      if (pin.hostKeyFingerprint !== sshHostKeyFingerprint(pinnedHostKey))
        throw new Error("The SSH owner pinned a different host key; nothing was confirmed.");
    },
    async revokePin(pairingId) {
      try {
        await peer().revokePin(pairingId);
      } catch (error) {
        if (error instanceof PickerProofOwnerError && error.code === "peerPinUnknown") return;
        throw error;
      }
    },
  };
}
