import type { ServerGetRemoteAgentManualInstallResult } from "@bigbud/contracts/server/server.remoteAgentInstall";

import { REMOTE_AGENT_INBOX_RELATIVE_ROOT } from "./remoteAgentInstall.inbox.ts";
import {
  RemoteAgentInstallManagerError,
  type RemoteAgentInstallSource,
} from "./remoteAgentInstallManager.ts";
import { DEFAULT_RELEASE_REPOSITORY } from "./remoteAgentInstallSource.ts";

/** Published by the marketing site (D3); the same file is attached to every release. */
export const REMOTE_AGENT_SCRIPT_URL = "https://bigbud.app/remote-agent.sh";

const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** All artifacts in one signed release share a version; refuse a mixed source. */
export function remoteAgentManualInstallVersion(source: RemoteAgentInstallSource): string {
  const versions = new Set(source.manifest.artifacts.map((artifact) => artifact.version));
  const [version] = versions;
  if (versions.size !== 1 || !version || !SAFE_VERSION.test(version)) {
    throw new RemoteAgentInstallManagerError(
      "The remote agent install source does not name a single release version.",
    );
  }
  return version;
}

/**
 * Build the copyable remote command. It pins the version selected from the signed source, so
 * the script stages exactly the build the app will verify; staging never activates anything.
 */
export function buildRemoteAgentManualInstall(input: {
  readonly executionTargetId: string;
  readonly version: string;
  readonly repository?: string | undefined;
}): ServerGetRemoteAgentManualInstallResult {
  const repository = input.repository?.trim() || DEFAULT_RELEASE_REPOSITORY;
  if (!SAFE_VERSION.test(input.version) || !SAFE_REPOSITORY.test(repository)) {
    throw new RemoteAgentInstallManagerError("The remote agent release identity is invalid.");
  }
  const repositoryEnv =
    repository === DEFAULT_RELEASE_REPOSITORY ? "" : `BIGBUD_RELEASE_REPOSITORY=${repository} `;
  return {
    executionTargetId:
      input.executionTargetId as ServerGetRemoteAgentManualInstallResult["executionTargetId"],
    version: input.version,
    command: `curl -fsSL ${REMOTE_AGENT_SCRIPT_URL} | ${repositoryEnv}BIGBUD_AGENT_VERSION=${input.version} sh`,
    scriptUrl: REMOTE_AGENT_SCRIPT_URL,
    releaseScriptUrl: `https://github.com/${repository}/releases/download/v${input.version}/remote-agent.sh`,
    inboxRelativePath: `~/${REMOTE_AGENT_INBOX_RELATIVE_ROOT}`,
  };
}
