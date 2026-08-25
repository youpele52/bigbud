import { resolveDesktopReleaseIdentity } from "@bigbud/shared/desktopReleaseIdentity";
import { resolveReleaseVersion, type ReleaseTrack } from "@bigbud/shared/releaseChannel";

export interface ReleaseMetadata {
  readonly channel: ReleaseTrack;
  readonly isPrerelease: boolean;
  readonly makeLatest: boolean;
  readonly tag: string;
  readonly updateChannel: "latest" | Exclude<ReleaseTrack, "stable">;
  readonly version: string;
}

export function resolveReleaseMetadata(input: string): ReleaseMetadata {
  const release = resolveReleaseVersion(input);
  if (!release) {
    throw new Error(`Invalid or unsupported release version: ${input}`);
  }
  const identity = resolveDesktopReleaseIdentity(release.version);
  return {
    channel: release.channel,
    isPrerelease: release.isPrerelease,
    makeLatest: !release.isPrerelease,
    tag: `v${release.version}`,
    updateChannel: identity.updaterChannel,
    version: release.version,
  };
}

export function macUpdateManifestName(updateChannel: ReleaseMetadata["updateChannel"]): string {
  return `${updateChannel}-mac.yml`;
}

export function macArchitectureManifestName(
  updateChannel: ReleaseMetadata["updateChannel"],
  architecture: string,
): string {
  return architecture === "arm64"
    ? macUpdateManifestName(updateChannel)
    : `${updateChannel}-mac-${architecture}.yml`;
}
