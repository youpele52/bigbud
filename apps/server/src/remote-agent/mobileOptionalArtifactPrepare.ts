import type { MobileOptionalArtifact } from "@bigbud/contracts/server/mobileOptionalArtifact";
import {
  assertMobileOptionalArtifactCompatibility,
  parseMobileOptionalArtifact,
  verifyMobileOptionalArtifactBytes,
  verifyMobileOptionalArtifactSignature,
  type MobileOptionalArtifactHost,
} from "@bigbud/shared/mobileOptionalArtifact";

import {
  downloadRemoteAgentHttp,
  type RemoteAgentHttpDownloadDependencies,
} from "./remoteAgentHttpDownload.ts";
import { REMOTE_AGENT_ARTIFACT_DOWNLOAD_POLICY } from "./remoteAgentHttpDownload.policy.ts";
import { parseAndValidateDownloadUrl } from "./remoteAgentHttpDownload.url.ts";

export interface MobileOptionalArtifactPreparation {
  readonly mobileConsent: boolean;
  readonly gateway: unknown;
  readonly assets: unknown;
  readonly trustedKeys: Readonly<Record<string, string>>;
  readonly host: MobileOptionalArtifactHost;
  readonly signal?: AbortSignal;
}

export interface PreparedMobileOptionalComponent {
  readonly artifact: MobileOptionalArtifact;
  readonly bytes: Uint8Array;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("caller", "AbortError");
}

/**
 * Bounded preparation only. No extraction, process launch, active-pointer change or DB access.
 * The existing install CAS owner must recheck consent and hashes when staging/activating.
 */
export async function prepareMobileOptionalArtifacts(
  input: MobileOptionalArtifactPreparation,
  dependencies: RemoteAgentHttpDownloadDependencies = {},
): Promise<readonly PreparedMobileOptionalComponent[] | null> {
  // Separate mobile consent is required even to inspect or fetch optional components.
  if (input.mobileConsent !== true) return null;
  checkAbort(input.signal);
  // Decode into fresh records: caller mutation during a download cannot alter signed metadata.
  const gateway = parseMobileOptionalArtifact(input.gateway);
  const assets = parseMobileOptionalArtifact(input.assets);
  if (gateway.kind !== "mobile-gateway" || assets.kind !== "mobile-assets") {
    throw new Error("Mobile preparation requires a gateway and a distinct assets artifact.");
  }
  const compatibility = gateway.compatibility;
  for (const artifact of [gateway, assets]) {
    verifyMobileOptionalArtifactSignature(artifact, input.trustedKeys);
    parseAndValidateDownloadUrl(artifact.url, {});
    assertMobileOptionalArtifactCompatibility(artifact, input.host, compatibility);
    if (
      artifact.compatibility.minimumMobileRpcRevision !== compatibility.minimumMobileRpcRevision ||
      artifact.compatibility.maximumMobileRpcRevision !== compatibility.maximumMobileRpcRevision
    ) {
      throw new Error("Mobile component RPC ranges must describe the same release tuple.");
    }
  }
  const prepared: PreparedMobileOptionalComponent[] = [];
  // Sequential downloads bound retained bytes to two existing-policy artifacts, no new transport.
  for (const artifact of [gateway, assets]) {
    checkAbort(input.signal);
    const bytes = await downloadRemoteAgentHttp(
      {
        url: artifact.url,
        expectedBytes: artifact.sizeBytes,
        policy: REMOTE_AGENT_ARTIFACT_DOWNLOAD_POLICY,
        ...(input.signal ? { signal: input.signal } : {}),
      },
      dependencies,
    );
    checkAbort(input.signal);
    verifyMobileOptionalArtifactBytes(artifact, bytes);
    prepared.push({ artifact, bytes });
  }
  return prepared;
}
