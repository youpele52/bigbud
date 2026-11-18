/**
 * Coordinator peer key handling (D10, WP-8C). The coordinator generates a dedicated ed25519 key
 * after approval; only its public half is authorized on workers. The fingerprint bound into a
 * grant is `sha256:` plus the hex sha256 of the decoded public key blob.
 *
 * @module peerSshKey
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

export interface PeerPublicKey {
  readonly type: "ssh-ed25519";
  readonly base64: string;
  readonly fingerprint: string;
}

/** Accepts exactly `ssh-ed25519 <base64> [comment]`; the comment is discarded. */
export function parsePeerPublicKey(line: string): PeerPublicKey {
  const trimmed = line.trim();
  const [type, base64, ...rest] = trimmed.split(/\s+/);
  if (
    /[\r\n]/.test(trimmed) ||
    type !== "ssh-ed25519" ||
    !base64 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
    rest.join(" ").length > 256
  )
    throw new Error("The peer key must be a single ssh-ed25519 public key.");
  const blob = Buffer.from(base64, "base64");
  // string "ssh-ed25519" (4 + 11 bytes) then string key (4 + 32 bytes).
  if (
    blob.length !== 51 ||
    blob.readUInt32BE(0) !== 11 ||
    blob.subarray(4, 15).toString("latin1") !== "ssh-ed25519" ||
    blob.readUInt32BE(15) !== 32 ||
    blob.toString("base64") !== base64
  )
    throw new Error("The peer key is not a well-formed ssh-ed25519 public key.");
  return {
    type,
    base64,
    fingerprint: `sha256:${createHash("sha256").update(blob).digest("hex")}`,
  };
}

/** One pinned host key: `<type> <base64>` (as in `ssh-keyscan` or a `.pub` file). */
export function parsePinnedHostKey(value: string): string {
  const [type, base64, ...rest] = value.trim().split(/\s+/);
  if (
    rest.length > 1 ||
    !type ||
    !/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa|rsa-sha2-(256|512))$/.test(type) ||
    !base64 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
  )
    throw new Error("The pinned host key must be `<type> <base64>`.");
  return `${type} ${base64}`;
}

/**
 * Generates (or reuses) the coordinator's dedicated peer key in a private directory. Never reads
 * the user's own keys or agent; the private half never leaves this host.
 */
export async function ensureCoordinatorPeerKey(directory: string, sshKeygen = "ssh-keygen") {
  if (!isAbsolute(directory) || /\s/.test(directory))
    throw new Error("The peer key directory must be an absolute path without whitespace.");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("The peer key directory must be a private directory owned by this account.");
  const keyFile = join(directory, "peer_ed25519");
  const exists = await lstat(keyFile).then(
    (stat) => {
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
        throw new Error("The peer private key is not a private file owned by this account.");
      return true;
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (!exists)
    await promisify(execFile)(
      sshKeygen,
      ["-q", "-t", "ed25519", "-N", "", "-C", "bigbud-peer", "-f", keyFile],
      { timeout: 15_000 },
    );
  const publicKey = parsePeerPublicKey(await readFile(`${keyFile}.pub`, "utf8"));
  return { keyFile, publicKey };
}
