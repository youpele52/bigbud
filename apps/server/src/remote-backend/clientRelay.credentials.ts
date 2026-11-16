import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ownershipStateDir } from "@bigbud/shared/backendOwnership.paths";
import { readLocalSupervisorServiceConfig } from "./localSupervisorService.config.read.ts";
import {
  assertLocalSupervisorServiceDirectory,
  readLocalSupervisorServiceFile,
} from "./localSupervisorService.files.ts";

/** Credentials remain inside the account helper; no lock, identity generation or runtime mutation. */
export async function readClientRelayCredentials(homeDir: string, authorityId: string) {
  if (process.platform !== "linux" || !/^[a-f0-9]{32}$/.test(authorityId))
    throw new Error("Client relay requires a Linux account authority.");
  const root = join(homeDir, ".bigbud/backend-services", authorityId);
  const { config } = await readLocalSupervisorServiceConfig({
    homeDir,
    configPath: join(root, "config-v1"),
    authorityId,
  });
  const token = await readLocalSupervisorServiceFile(join(root, "client-token"), 4096);
  if (!/^[!-~]+$/.test(token)) throw new Error("Invalid private client credential.");
  const stateDir = ownershipStateDir(config.backend_home, false);
  await assertLocalSupervisorServiceDirectory(stateDir);
  const socketPath = join(stateDir, "remote-backend.sock");
  if (Buffer.byteLength(socketPath) >= 108) throw new Error("Client socket path is oversized.");
  const socket = await lstat(socketPath);
  if (
    !socket.isSocket() ||
    socket.uid !== process.getuid?.() ||
    (socket.mode & 0o7777) !== 0o600 ||
    socket.nlink !== 1
  )
    throw new Error("Private backend client socket is unavailable.");
  return { socketPath, token };
}
