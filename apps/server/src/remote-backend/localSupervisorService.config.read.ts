import { basename, dirname, join } from "node:path";
import { decodeLocalSupervisorServiceConfig } from "./localSupervisorService.config.ts";
import {
  assertLocalSupervisorServiceDirectory,
  readLocalSupervisorServiceFile,
} from "./localSupervisorService.files.ts";

/** Read-only stable account config validation shared by early startup and P4 launch preparation. */
export async function readLocalSupervisorServiceConfig(input: {
  readonly homeDir: string;
  readonly configPath: string;
  readonly authorityId?: string;
}) {
  const root = join(input.homeDir, ".bigbud/backend-services");
  const authority = basename(dirname(input.configPath));
  if (
    !/^[a-f0-9]{32}$/.test(authority) ||
    (input.authorityId !== undefined && input.authorityId !== authority) ||
    input.configPath !== join(root, authority, "config-v1")
  )
    throw new Error("Service config must use the stable account authority path.");
  await assertLocalSupervisorServiceDirectory(input.homeDir, [0o700, 0o750, 0o755]);
  await assertLocalSupervisorServiceDirectory(join(input.homeDir, ".bigbud"), [0o700, 0o755]);
  await assertLocalSupervisorServiceDirectory(root);
  await assertLocalSupervisorServiceDirectory(dirname(input.configPath));
  const raw = await readLocalSupervisorServiceFile(input.configPath, 32 * 1024);
  const config = decodeLocalSupervisorServiceConfig(raw);
  if (config.home !== input.homeDir || config.authority !== authority)
    throw new Error("Service config belongs to another account or authority.");
  return { config, raw };
}
