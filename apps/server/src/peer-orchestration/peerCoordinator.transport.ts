/**
 * Live coordinator peer transport (WP-8D): `ensureCoordinatorPeerKey`, then one dedicated-key SSH
 * channel per request (`makePeerRelaySshChannels`), then `sendPeerRequest`. A request that fails
 * is classified from the ssh exit: a host key mismatch or refused key is a setup error, anything
 * else is "unreachable" (the dispatcher then probes status, never relaunches).
 *
 * @module peerCoordinator.transport
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import type { PeerScannedHostKey } from "@bigbud/contracts/server/remotePeer.pairing.ts";

import {
  classifyPeerReply,
  type PeerTransport,
  type PeerTransportOutcome,
} from "../orchestration-tools/peerDispatch.transport.ts";
import { sendPeerRequest } from "../remote-backend/peerRelay.request.ts";
import { makePeerRelaySshChannels } from "../remote-backend/peerRelay.ssh.ts";
import { ensureCoordinatorPeerKey, parsePinnedHostKey } from "./peerSshKey.ts";

export const peerCoordinatorKeyDirectory = (stateDir: string) => join(stateDir, "peer-coordinator");
const knownHostsDirectory = (keyDirectory: string) => join(keyDirectory, "known_hosts");

const SETUP_MESSAGES = {
  "host-identity-mismatch":
    "The worker's host key does not match the pinned key. Re-scan and confirm the pin in Settings.",
  "authentication-refused":
    "The worker refused the coordinator key. Run the bigbud peer grant command on the worker.",
} as const;

const exitWithin = <T>(promise: Promise<T>, ms: number, fallback: T) =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

export function makeSshPeerTransport(input: {
  readonly keyDirectory: string;
  readonly sshBinary?: string;
}): PeerTransport {
  return {
    async request({ pairing, action, body, deadlineMs, signal }): Promise<PeerTransportOutcome> {
      const { keyFile } = await ensureCoordinatorPeerKey(input.keyDirectory);
      const channels = makePeerRelaySshChannels({
        target: {
          host: pairing.host,
          port: pairing.port,
          user: pairing.user,
          workerAuthorityId: pairing.workerAuthorityId,
          pinnedHostKey: pairing.pinnedHostKey,
          identityFile: keyFile,
        },
        knownHostsDirectory: knownHostsDirectory(input.keyDirectory),
        ...(input.sshBinary ? { sshBinary: input.sshBinary } : {}),
      });
      try {
        const channel = await channels.openChannel(signal);
        try {
          const reply = await sendPeerRequest(channel.stream, action, body, { deadlineMs, signal });
          return classifyPeerReply(reply.status, reply.body);
        } catch (error) {
          channel.stream.end();
          const exit = await exitWithin(channel.outcome, 3_000, "unreachable" as const);
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

/** Parses `ssh-keyscan` output lines (`host type base64`), dropping comments and duplicates. */
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

/** Reads the worker's host keys for the user to compare and confirm; never pins anything. */
export async function scanPeerHostKeys(
  host: string,
  port: number,
  keyscan = "ssh-keyscan",
): Promise<ReadonlyArray<PeerScannedHostKey>> {
  const { stdout } = await promisify(execFile)(
    keyscan,
    ["-T", "10", "-p", String(port), "-t", "ed25519,ecdsa,rsa", "--", host],
    { timeout: 20_000, maxBuffer: 64 * 1024 },
  );
  return parseKeyscanOutput(stdout);
}
