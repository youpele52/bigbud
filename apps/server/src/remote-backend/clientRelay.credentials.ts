import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ownershipStateDir } from "@bigbud/shared/backendOwnership.paths";
import { readLocalSupervisorServiceConfig } from "./localSupervisorService.config.read.ts";
import {
  assertLocalSupervisorServiceDirectory,
  readLocalSupervisorServiceFile,
} from "./localSupervisorService.files.ts";

/** This account's service root and backend state directory for `authorityId`. Linux only. */
export async function readRelayServiceRoot(homeDir: string, authorityId: string) {
  if (process.platform !== "linux" || !/^[a-f0-9]{32}$/.test(authorityId))
    throw new Error("Relay helpers require a Linux account authority.");
  const root = join(homeDir, ".bigbud/backend-services", authorityId);
  const { config } = await readLocalSupervisorServiceConfig({
    homeDir,
    configPath: join(root, "config-v1"),
    authorityId,
  });
  const stateDir = ownershipStateDir(config.backend_home, false);
  await assertLocalSupervisorServiceDirectory(stateDir);
  return { root, stateDir };
}

/** An owned, single-link 0600 Unix socket; anything else is refused. */
export async function assertPrivateRelaySocket(socketPath: string) {
  if (Buffer.byteLength(socketPath) >= 108) throw new Error("Socket path is oversized.");
  const socket = await lstat(socketPath);
  if (
    !socket.isSocket() ||
    socket.uid !== process.getuid?.() ||
    (socket.mode & 0o7777) !== 0o600 ||
    socket.nlink !== 1
  )
    throw new Error("Private backend socket is unavailable.");
  return socketPath;
}

/** Credentials remain inside the account helper; no lock, identity generation or runtime mutation. */
export async function readClientRelayCredentials(homeDir: string, authorityId: string) {
  const { root, stateDir } = await readRelayServiceRoot(homeDir, authorityId);
  const token = await readLocalSupervisorServiceFile(join(root, "client-token"), 4096);
  if (!/^[!-~]+$/.test(token)) throw new Error("Invalid private client credential.");
  const socketPath = await assertPrivateRelaySocket(join(stateDir, "remote-backend.sock"));
  return { socketPath, token };
}
