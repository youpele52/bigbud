/**
 * Worker `authorized_keys` maintenance for peer grants (D10, WP-8C). Each grant's key gets one
 * line, `restrict,command="<node> <helper> <worker> <grant> <coordinator> <fingerprint>"`, so the
 * key can only run the peer relay helper, which only reaches the peer socket. Writes are atomic
 * (private temp file, fsync, rename), serialized by an exclusive lock file, idempotent and never
 * duplicate a grant, coordinator or key.
 *
 * @module peerAuthorizedKeys
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

import { parsePeerPublicKey } from "../peer-orchestration/peerSshKey.ts";

const SAFE_PATH = /^\/[A-Za-z0-9._/+@-]+$/;
const MARKER = /\sbigbud-peer:([0-9a-f]{32}):([0-9a-f-]{36})$/;

export interface PeerAuthorizedKeyInput {
  readonly nodeBinary: string;
  readonly helperEntry: string;
  readonly workerAuthorityId: string;
  readonly grantId: string;
  readonly coordinatorAuthorityId: string;
  readonly publicKey: string;
}

/** The single restricted line for one grant. Paths are limited to a quote-free safe alphabet. */
export function peerAuthorizedKeysLine(input: PeerAuthorizedKeyInput): string {
  const key = parsePeerPublicKey(input.publicKey);
  for (const path of [input.nodeBinary, input.helperEntry])
    if (!SAFE_PATH.test(path) || path.includes("/../") || path.endsWith("/.."))
      throw new Error("The peer helper paths must be absolute and use only safe characters.");
  if (
    !/^[0-9a-f]{32}$/.test(input.workerAuthorityId) ||
    !/^[0-9a-f]{32}$/.test(input.coordinatorAuthorityId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.grantId)
  )
    throw new Error("Invalid peer grant identity.");
  const command = [
    input.nodeBinary,
    input.helperEntry,
    input.workerAuthorityId,
    input.grantId,
    input.coordinatorAuthorityId,
    key.fingerprint,
  ].join(" ");
  return `restrict,command="${command}" ${key.type} ${key.base64} bigbud-peer:${input.coordinatorAuthorityId}:${input.grantId}`;
}

const keyBlobOf = (line: string) =>
  line.match(/(?:^|\s)ssh-ed25519\s+([A-Za-z0-9+/]+={0,2})(?:\s|$)/)?.[1];
const markerOf = (line: string) => {
  const match = line.trimEnd().match(MARKER);
  return match ? { coordinatorAuthorityId: match[1]!, grantId: match[2]! } : undefined;
};

/** Pure merge: drop this coordinator's and this key's previous peer lines, then add `line`. */
export function mergePeerAuthorizedKeys(existing: string, line: string): string {
  const blob = keyBlobOf(line);
  const marker = markerOf(line);
  if (!blob || !marker) throw new Error("Not a peer authorized_keys line.");
  const kept: string[] = [];
  for (const current of existing.split("\n")) {
    if (current === "") continue;
    const currentMarker = markerOf(current);
    if (currentMarker) {
      if (currentMarker.coordinatorAuthorityId === marker.coordinatorAuthorityId) continue;
      if (keyBlobOf(current) === blob) continue;
    } else if (keyBlobOf(current) === blob)
      // An unrestricted line for the same key would defeat the forced command.
      throw new Error("This key is already authorized without the peer restriction.");
    kept.push(current);
  }
  kept.push(line);
  return `${kept.join("\n")}\n`;
}

/** Pure removal of the peer lines for one grant. */
export function removePeerAuthorizedKeys(existing: string, grantId: string): string {
  const kept = existing
    .split("\n")
    .filter((line) => line !== "" && markerOf(line)?.grantId !== grantId);
  return kept.length === 0 ? "" : `${kept.join("\n")}\n`;
}

async function readOwned(file: string): Promise<string> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.uid !== process.getuid?.())
      throw new Error("authorized_keys must be a regular file owned by this account.");
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function ensureSshDirectory(directory: string) {
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)
    throw new Error(
      "The SSH directory must be a directory owned and writable only by this account.",
    );
}

async function withLock<A>(file: string, run: () => Promise<A>): Promise<A> {
  const lock = `${file}.bigbud-lock`;
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(
        lock,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt >= 50)
        throw new Error(
          `authorized_keys is locked; remove ${lock} if no bigbud peer command runs.`,
          { cause: error },
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await run();
  } finally {
    await unlink(lock).catch(() => {});
  }
}

/** Atomically replaces `file` when `update` changes it; returns whether it changed. */
export async function updateAuthorizedKeys(
  file: string,
  update: (existing: string) => string,
): Promise<boolean> {
  if (!isAbsolute(file)) throw new Error("authorized_keys path must be absolute.");
  const directory = dirname(file);
  await ensureSshDirectory(directory);
  return withLock(file, async () => {
    const existing = await readOwned(file);
    const next = update(existing);
    if (next === existing) return false;
    const temp = join(directory, `.authorized_keys.bigbud-${randomBytes(8).toString("hex")}`);
    const handle = await open(
      temp,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile(next, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temp, file);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
    const dir = await open(directory, constants.O_RDONLY);
    await dir.sync().finally(() => dir.close());
    return true;
  });
}
