/**
 * Live coordinator peer transport (WP-8D, T-peer / U9).
 *
 * Every channel is opened by the Rust owner from the saved pairing approval: the
 * pinned worker host key and the dedicated coordinator identity bound by the
 * grant are both required, and ordinary user host trust or a shared master can
 * never substitute. The TypeScript path launches no `ssh`, `ssh-keygen` or
 * `ssh-keyscan`; an absent owner refuses instead of falling back.
 *
 * @module peerCoordinator.transport
 */
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { PeerScannedHostKey } from "@bigbud/contracts/server/remotePeer.pairing.ts";

import {
  classifyPeerReply,
  type PeerTransport,
  type PeerTransportOutcome,
} from "../orchestration-tools/peerDispatch.transport.ts";
import {
  makeOwnedPeerRelaySshChannels,
  PeerRelayAdmissionError,
  type PeerRelaySshOwner,
} from "../remote-backend/peerRelay.ssh.owner.ts";
import { sendPeerRequest } from "../remote-backend/peerRelay.request.ts";
import type { PeerRelayChannelOutcome } from "../remote-backend/peerRelay.ssh.ts";
import {
  PeerEnrollmentOwnerMismatchError,
  PeerEnrollmentOwnerUnavailableError,
  parsePinnedHostKey,
} from "./peerSshKey.ts";

export const peerCoordinatorKeyDirectory = (stateDir: string) => join(stateDir, "peer-coordinator");

const SETUP_MESSAGES = {
  "host-identity-mismatch":
    "The worker's host key does not match the pinned key. Re-scan and confirm the pin in Settings.",
  "authentication-refused":
    "The worker refused the coordinator key. Run the bigbud peer grant command on the worker.",
} as const;

const exitWithin = <T>(promise: Promise<T>, ms: number, fallback: T) =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

/** Owner port for one-shot, exact-target host-key inspection. */
export interface PeerHostKeyInspectionOwner {
  inspectPeerHostKey(
    host: string,
    port: number,
  ): Promise<{
    readonly keyType: string;
    readonly fingerprint: string;
    readonly publicKey: string;
  }>;
}

/**
 * Read the worker's currently presented host key for the user to compare.
 * Returns metadata only; the owner saves no pin and releases no credential.
 */
export async function scanPeerHostKeys(
  owner: PeerHostKeyInspectionOwner | undefined,
  host: string,
  port: number,
): Promise<ReadonlyArray<PeerScannedHostKey>> {
  if (!owner)
    throw new PeerEnrollmentOwnerUnavailableError(
      "The selected SSH owner must inspect the peer host key.",
    );
  const key = await owner.inspectPeerHostKey(host, port);
  let pinnedHostKey: string;
  try {
    pinnedHostKey = parsePinnedHostKey(key.publicKey);
  } catch {
    throw new PeerEnrollmentOwnerMismatchError(
      "The SSH owner returned an invalid presented host key.",
    );
  }
  if (
    key.keyType !== pinnedHostKey.split(" ")[0] ||
    sshHostKeyFingerprint(pinnedHostKey) !== key.fingerprint
  )
    throw new PeerEnrollmentOwnerMismatchError(
      "The SSH owner returned inconsistent host-key metadata.",
    );
  return [{ pinnedHostKey, fingerprint: key.fingerprint }];
}

export function makeSshPeerTransport(input: {
  readonly owner?: PeerRelaySshOwner | undefined;
}): PeerTransport {
  return {
    async request({ pairing, action, body, deadlineMs, signal }): Promise<PeerTransportOutcome> {
      signal.throwIfAborted();
      if (!input.owner)
        return {
          _tag: "unreachable",
          message: "The selected SSH owner is unavailable for peer relay.",
        };
      let channels: ReturnType<typeof makeOwnedPeerRelaySshChannels>;
      try {
        channels = makeOwnedPeerRelaySshChannels(pairing, input.owner);
      } catch (error) {
        if (error instanceof PeerRelayAdmissionError)
          return {
            _tag: "setup",
            code: "authentication-refused",
            message: SETUP_MESSAGES["authentication-refused"],
          };
        return {
          _tag: "unreachable",
          message: error instanceof Error ? error.message : "The worker is unreachable.",
        };
      }
      try {
        const channel = await channels.openChannel(signal);
        try {
          const reply = await sendPeerRequest(channel.stream, action, body, { deadlineMs, signal });
          return classifyPeerReply(reply.status, reply.body);
        } catch (error) {
          channel.stream.end();
          const exit: PeerRelayChannelOutcome = await exitWithin(
            channel.outcome,
            3_000,
            "unreachable",
          );
          if (exit === "host-identity-mismatch" || exit === "authentication-refused")
            return { _tag: "setup", code: exit, message: SETUP_MESSAGES[exit] };
          return {
            _tag: "unreachable",
            message: error instanceof Error ? error.message : "The worker is unreachable.",
          };
        } finally {
          channel.stream.destroy();
        }
      } catch (error) {
        if (error instanceof PeerRelayAdmissionError)
          return {
            _tag: "setup",
            code: "authentication-refused",
            message: SETUP_MESSAGES["authentication-refused"],
          };
        return {
          _tag: "unreachable",
          message: error instanceof Error ? error.message : "The worker is unreachable.",
        };
      } finally {
        await channels.dispose().catch(() => {});
      }
    },
  };
}

/** `SHA256:<base64>` exactly as `ssh-keygen -lf` prints it. */
export function sshHostKeyFingerprint(pinnedHostKey: string): string {
  const [, base64] = parsePinnedHostKey(pinnedHostKey).split(" ");
  const digest = createHash("sha256").update(Buffer.from(base64!, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** Parses host-key lines (`host type base64`), dropping comments and duplicates. */
export function parseKeyscanOutput(output: string): ReadonlyArray<PeerScannedHostKey> {
  const keys = new Map<string, PeerScannedHostKey>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [, type, base64] = trimmed.split(/\s+/);
    try {
      const pinnedHostKey = parsePinnedHostKey(`${type} ${base64}`);
      keys.set(pinnedHostKey, { pinnedHostKey, fingerprint: sshHostKeyFingerprint(pinnedHostKey) });
    } catch {
      // Not a key line.
    }
  }
  return [...keys.values()].slice(0, 8);
}
