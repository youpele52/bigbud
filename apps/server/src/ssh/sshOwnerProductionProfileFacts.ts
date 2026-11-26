import { access } from "node:fs/promises";
import { homedir } from "node:os";

import { readProductionOpencodeV2Service } from "./sshOwnerDevRuntime.providerServices.ts";
import {
  resolveProductionSshConfigPaths,
  type SshOwnerProductionProfile,
} from "./sshOwnerProductionClient.launch.ts";

/**
 * Settings- and environment-derived facts for the production owner profile:
 * the OpenCode v2 binding (explicit `remoteBinaryPath`, else remote discovery)
 * and the user's SSH config paths so alias targets resolve in the owner.
 *
 * @module sshOwnerProductionProfileFacts
 */
export async function readProductionOwnerProfileFacts(
  settingsPath: string,
  home: string = homedir(),
): Promise<
  Pick<
    SshOwnerProductionProfile,
    "opencodeV2Service" | "opencodeV2Refusal" | "aliasConfig" | "systemConfig"
  >
> {
  const exists = (path: string) =>
    access(path).then(
      () => true,
      () => false,
    );
  const [opencodeV2, sshConfig] = await Promise.all([
    readProductionOpencodeV2Service(settingsPath),
    resolveProductionSshConfigPaths(home, exists),
  ]);
  return { ...opencodeV2, ...sshConfig };
}
