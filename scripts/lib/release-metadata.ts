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
  const sourceVersion = input.trim().replace(/^v/, "");
  // Legacy tags may pad the patch number; package/updater versions must remain SemVer.
  const canonicalVersion = sourceVersion.replace(
    /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.)0+(\d+)(?=-|$)/,
    (_match, core: string, patch: string) => `${core}${patch.replace(/^0+(?=\d)/, "")}`,
  );
  const release = resolveReleaseVersion(canonicalVersion);
  if (!release) {
    throw new Error(`Invalid or unsupported release version: ${input}`);
  }
  const identity = resolveDesktopReleaseIdentity(release.version);
  return {
    channel: release.channel,
    isPrerelease: release.isPrerelease,
    makeLatest: !release.isPrerelease,
    tag: `v${sourceVersion}`,
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
