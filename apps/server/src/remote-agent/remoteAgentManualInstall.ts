import type { ServerGetRemoteAgentManualInstallResult } from "@bigbud/contracts/server/server.remoteAgentInstall";
import { resolveReleaseVersion } from "@bigbud/shared/releaseChannel";

import { REMOTE_AGENT_INBOX_RELATIVE_ROOT } from "./remoteAgentInstall.inbox.ts";
import {
  RemoteAgentInstallManagerError,
  type RemoteAgentInstallSource,
} from "./remoteAgentInstallManager.ts";
import { DEFAULT_RELEASE_REPOSITORY } from "./remoteAgentInstallSource.ts";

/**
 * The marketing site redirects `/download/v<version>/remote-agent` to that release's
 * `remote-agent.sh` asset (D3), so users only ever run the reviewed, version-stamped release copy.
 */
export const REMOTE_AGENT_DOWNLOAD_BASE = "https://bigbud.app/download";

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
  const isDefaultRepository = repository === DEFAULT_RELEASE_REPOSITORY;
  const repositoryEnv = isDefaultRepository ? "" : `BIGBUD_RELEASE_REPOSITORY=${repository} `;
  const releaseScriptUrl = `https://github.com/${repository}/releases/download/v${input.version}/remote-agent.sh`;
  // bigbud.app redirects only the default repository's release tags in the shared version
  // format; anything else (a fork, a build-metadata version) uses its release asset directly,
  // so the copied command never reaches a 404 from the download link.
  const linkable = resolveReleaseVersion(input.version)?.version === input.version;
  const scriptUrl =
    isDefaultRepository && linkable
      ? `${REMOTE_AGENT_DOWNLOAD_BASE}/v${input.version}/remote-agent`
      : releaseScriptUrl;
  return {
    executionTargetId:
      input.executionTargetId as ServerGetRemoteAgentManualInstallResult["executionTargetId"],
    version: input.version,
    command: `curl -fsSL ${scriptUrl} | ${repositoryEnv}BIGBUD_AGENT_VERSION=${input.version} sh`,
    scriptUrl,
    releaseScriptUrl,
    inboxRelativePath: `~/${REMOTE_AGENT_INBOX_RELATIVE_ROOT}`,
  };
}
