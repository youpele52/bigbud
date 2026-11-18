/**
 * Coordinator-side SSH peer transport (D10, WP-8C), following `clientRelay.ssh.ts`. Each channel
 * is one `ssh` child authenticating with the coordinator's dedicated key only (no agent, no other
 * identities, no forwarding) against a pinned worker host key; the worker's forced command picks
 * the peer relay helper, so the coordinator sends no command of its own. A host key mismatch is
 * refused by ssh's strict checking and reported as `host-identity-mismatch`.
 *
 * @module peerRelay.ssh
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Duplex } from "node:stream";

import { parsePinnedHostKey } from "../peer-orchestration/peerSshKey.ts";
import { ownClientRelaySshChild } from "./clientRelay.ssh.child.ts";

export interface PeerRelaySshTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly workerAuthorityId: string;
  /** `<type> <base64>`; the only host key accepted for this worker. */
  readonly pinnedHostKey: string;
  /** The coordinator's dedicated private key file. */
  readonly identityFile: string;
}

export type PeerRelayChannelOutcome =
  | "closed"
  | "host-identity-mismatch"
  | "authentication-refused"
  | "unreachable";

export interface PeerRelayChannel {
  readonly stream: Duplex;
  /** Settles when the ssh child exits, classifying why the channel ended. */
  readonly outcome: Promise<PeerRelayChannelOutcome>;
}

const SAFE_PATH = /^\/[A-Za-z0-9._/+@-]+$/;
const option = (value: string) => ["-o", value];

export function peerHostAlias(workerAuthorityId: string) {
  if (!/^[0-9a-f]{32}$/.test(workerAuthorityId)) throw new Error("Invalid worker authority.");
  return `bigbud-peer-${workerAuthorityId}`;
}

/** Writes the single pinned known_hosts entry privately and atomically; returns its path. */
export async function writePinnedKnownHosts(directory: string, target: PeerRelaySshTarget) {
  if (!SAFE_PATH.test(directory)) throw new Error("Invalid known-hosts directory.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("The known-hosts directory must be private to this account.");
  const alias = peerHostAlias(target.workerAuthorityId);
  const file = join(directory, `${alias}.known_hosts`);
  const temp = join(directory, `.${alias}.${randomBytes(6).toString("hex")}`);
  const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(`${alias} ${parsePinnedHostKey(target.pinnedHostKey)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, file).catch(async (error) => {
    await unlink(temp).catch(() => {});
    throw error;
  });
  return file;
}

/** Full ssh argv; every security-relevant option is explicit and overrides user configuration. */
export function peerRelaySshArgs(
  target: PeerRelaySshTarget,
  knownHostsFile: string,
  configFile?: string,
): string[] {
  if (
    !/^[A-Za-z0-9.-]{1,253}$|^[0-9A-Fa-f:]{2,39}$/.test(target.host) ||
    target.host.startsWith("-") ||
    !/^[a-z_][a-z0-9_.-]{0,31}$/.test(target.user) ||
    !Number.isInteger(target.port) ||
    target.port < 1 ||
    target.port > 65535 ||
    !SAFE_PATH.test(target.identityFile) ||
    !isAbsolute(knownHostsFile) ||
    !SAFE_PATH.test(knownHostsFile) ||
    (configFile !== undefined && !SAFE_PATH.test(configFile))
  )
    throw new Error("Invalid peer SSH target.");
  return [
    ...(configFile ? ["-F", configFile] : []),
    "-T",
    "-x",
    "-a",
    "-i",
    target.identityFile,
    ...option("IdentitiesOnly=yes"),
    ...option("IdentityAgent=none"),
    ...option("BatchMode=yes"),
    ...option("PasswordAuthentication=no"),
    ...option("KbdInteractiveAuthentication=no"),
    ...option("StrictHostKeyChecking=yes"),
    ...option(`UserKnownHostsFile=${knownHostsFile}`),
    ...option("GlobalKnownHostsFile=/dev/null"),
    ...option(`HostKeyAlias=${peerHostAlias(target.workerAuthorityId)}`),
    ...option("CheckHostIP=no"),
    ...option("UpdateHostKeys=no"),
    ...option("ClearAllForwardings=yes"),
    ...option("ForwardAgent=no"),
    ...option("PermitLocalCommand=no"),
    ...option("ConnectTimeout=10"),
    ...option("ServerAliveInterval=15"),
    ...option("ServerAliveCountMax=3"),
    "-p",
    String(target.port),
    "-l",
    target.user,
    "--",
    target.host,
    // Ignored by the worker's forced command; present so ssh requests exec, not a shell.
    "bigbud-peer",
  ];
}

export function classifyPeerRelayExit(
  code: number | null,
  stderr: string,
): PeerRelayChannelOutcome {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(stderr))
    return "host-identity-mismatch";
  if (/Permission denied \(/.test(stderr)) return "authentication-refused";
  return code === 0 ? "closed" : "unreachable";
}

/** Private coordinator-backend owner of peer channels to one worker. */
export function makePeerRelaySshChannels(input: {
  readonly target: PeerRelaySshTarget;
  readonly knownHostsDirectory: string;
  readonly sshBinary?: string;
  /** Tests only: a fixed ssh config file instead of the user's configuration. */
  readonly configFile?: string;
}) {
  const children = new Set<ReturnType<typeof ownClientRelaySshChild>>();
  let disposed = false;
  return {
    async openChannel(signal: AbortSignal): Promise<PeerRelayChannel> {
      signal.throwIfAborted();
      if (disposed) throw new Error("Peer relay owner is disposed.");
      const knownHosts = await writePinnedKnownHosts(input.knownHostsDirectory, input.target);
      signal.throwIfAborted();
      if (disposed) throw new Error("Peer relay owner is disposed.");
      const args = peerRelaySshArgs(input.target, knownHosts, input.configFile);
      const child = spawn(input.sshBinary ?? "ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 8192) stderr += chunk.toString("utf8");
      });
      const outcome = new Promise<PeerRelayChannelOutcome>((resolve) => {
        child.once("error", () => resolve("unreachable"));
        child.once("exit", (code) => resolve(classifyPeerRelayExit(code, stderr)));
      });
      const owner = ownClientRelaySshChild(child, signal);
      children.add(owner);
      void owner.exited.then(() => children.delete(owner));
      if (disposed) owner.stream.destroy();
      return { stream: owner.stream, outcome };
    },
    async dispose() {
      disposed = true;
      for (const owner of children) owner.stream.destroy();
      const result = await Promise.allSettled(
        [...children].map((owner) => owner.waitForExit(2500)),
      );
      if (result.some((entry) => entry.status === "rejected"))
        throw new Error("Peer relay cleanup could not confirm owned child exit.");
    },
  };
}
