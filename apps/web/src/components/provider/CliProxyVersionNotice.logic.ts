import type { CliProxyVersion } from "@bigbud/contracts/server/server.providers.ts";

export function cliProxyUpdateMessage(version: CliProxyVersion): string | null {
  if (version.updateSource === "runtime" && version.runtimeVersion) {
    return `The connected CLIProxyAPI server reports ${version.runtimeVersion}. Recommended baseline: ${version.recommendedVersion}. Older versions remain usable.`;
  }
  if (version.updateSource === "installed" && version.installedVersion) {
    return `The installed CLIProxyAPI binary on the server's PATH is ${version.installedVersion}. Recommended baseline: ${version.recommendedVersion}. The connected server version could not be verified and may differ. Older versions remain usable.`;
  }
  return null;
}
