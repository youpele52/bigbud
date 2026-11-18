import * as fs from "node:fs/promises";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { ensurePrivateRemoteStateRoot } from "./authority.files.ts";
import { RemoteBackendAuthorityError } from "./authority.record.ts";

/** Fixed, separate endpoints: authenticated clients, the Rust mobile gateway and P8 peers. */
export const REMOTE_SOCKET_NAMES = {
  client: "remote-backend.sock",
  mobile: "remote-mobile.sock",
  peer: "remote-peer.sock",
} as const;

export interface PrivateRemoteSocketOptions {
  readonly existing?: "recover-stale" | "refuse-existing";
}

interface SocketIdentity {
  readonly dev: number;
  readonly ino: number;
}
const sameSocket = (a: SocketIdentity, b: SocketIdentity) => a.dev === b.dev && a.ino === b.ino;
const unsafe = (message: string) => new RemoteBackendAuthorityError("unsafe-state", message);

async function inspectSocket(path: string) {
  try {
    const stat = await fs.lstat(path);
    if (!stat.isSocket() || stat.uid !== process.getuid?.())
      throw unsafe(
        "The remote client socket path is not an owned Unix socket. Preserve it for repair.",
      );
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function socketHasNoListener(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path });
    const done = (available: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(false));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED"));
  });
}

/** Called only while holding the state-root backend lock. Never remove a live or ambiguous socket. */
export async function preparePrivateRemoteSocket(
  stateDir: string,
  assertHeld: () => Promise<void>,
  endpoint: "client" | "mobile" | "peer",
  options: PrivateRemoteSocketOptions = {},
) {
  const existing = options.existing ?? "recover-stale";
  if (existing !== "recover-stale" && existing !== "refuse-existing")
    throw unsafe("Unknown remote socket recovery policy.");
  const assertRecoveryAllowed = () => {
    if (existing === "refuse-existing")
      throw unsafe("A preexisting remote socket must be preserved; activation cannot adopt it.");
  };
  await ensurePrivateRemoteStateRoot(stateDir);
  await assertHeld();
  const name = REMOTE_SOCKET_NAMES[endpoint];
  if (!Object.hasOwn(REMOTE_SOCKET_NAMES, endpoint) || !name)
    throw unsafe("Unknown remote socket endpoint.");
  const path = join(stateDir, name);
  if (Buffer.byteLength(path) >= 108)
    throw unsafe("The remote socket path exceeds the Unix socket limit.");
  // libuv removes the bound pathname during close. Never bind on the shared publication path:
  // another process may have replaced that name before finalization runs.
  const bindPath = join(stateDir, `.${randomBytes(8).toString("hex")}`);
  if (Buffer.byteLength(bindPath) >= 108)
    throw unsafe("The private remote bind path exceeds the Unix socket limit.");
  const previous = await inspectSocket(path);
  if (previous) {
    assertRecoveryAllowed();
    if (!(await socketHasNoListener(path)))
      throw unsafe("The remote client socket may still have a live listener.");
    await assertHeld();
    const current = await inspectSocket(path);
    if (!current || !sameSocket(previous, current))
      throw unsafe("The remote client socket changed during recovery.");
    assertRecoveryAllowed(); // Keep the strict activation policy at the actual stale-unlink boundary.
    await fs.unlink(path);
  }
  let published: SocketIdentity | undefined;
  return {
    path,
    bindPath,
    seal: async () => {
      await assertHeld();
      const before = await inspectSocket(bindPath);
      if (!before) throw unsafe("The remote client listener did not publish its Unix socket.");
      await fs.chmod(bindPath, 0o600);
      const after = await inspectSocket(bindPath);
      if (!after || !sameSocket(before, after) || (after.mode & 0o7777) !== 0o600)
        throw unsafe("The remote client socket changed while setting its permissions.");
      // Hard-link publication is no-clobber; the stable name never becomes a libuv-owned path.
      await fs.link(bindPath, path);
      const linked = await inspectSocket(path);
      if (!linked || !sameSocket(after, linked))
        throw unsafe("The remote client socket publication changed.");
      published = after;
      // Only the stable inode remains published. libuv retains its private bind name for close,
      // so its automatic unlink can never target the stable client endpoint.
      const bound = await inspectSocket(bindPath);
      if (!bound || !sameSocket(after, bound))
        throw unsafe("The private remote bind socket changed.");
      await fs.unlink(bindPath);
    },
    release: async () => {
      if (!published) return;
      await assertHeld();
      const current = await inspectSocket(path);
      if (current && sameSocket(published, current)) await fs.unlink(path);
    },
  };
}
