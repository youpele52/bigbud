import { ReleaseTrustError, requirePinnedReleaseTrust } from "@bigbud/shared/releaseTrust";

import {
  RemoteAgentInstallManagerError,
  type RemoteAgentInstallSource,
} from "./remoteAgentInstallManager.ts";

/**
 * Install-source trust rule.
 *
 * - Default release location (GitHub releases, including the repository/version selectors): the
 *   downloaded trust store is reduced to the keys pinned in `@bigbud/shared/releaseTrust`, and every
 *   manifest signing key id must survive, otherwise the load fails with an "update bigbud" error.
 * - Explicit local override (BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH / _URL): the operator chose
 *   the source and its trust, so the trust store is kept as-is and marked `localTrustOverride`.
 *   That marker is set here from local env only; parsed JSON never carries it.
 */
export function pinReleaseInstallSource(
  source: RemoteAgentInstallSource,
): RemoteAgentInstallSource {
  try {
    const trustStore = requirePinnedReleaseTrust(
      source.trustStore,
      source.manifest.artifacts.map((artifact) => artifact.signature.keyId),
    );
    return { manifest: source.manifest, trustStore };
  } catch (error) {
    if (error instanceof ReleaseTrustError) throw new RemoteAgentInstallManagerError(error.message);
    throw error;
  }
}

export function markLocalTrustOverride(source: RemoteAgentInstallSource): RemoteAgentInstallSource {
  return { manifest: source.manifest, trustStore: source.trustStore, localTrustOverride: true };
}
