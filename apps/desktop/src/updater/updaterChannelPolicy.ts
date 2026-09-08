import { resolveDesktopReleaseIdentity } from "@bigbud/shared/desktopReleaseIdentity";
import { resolveReleaseVersion, type ReleaseTrack } from "@bigbud/shared/releaseChannel";

export interface DesktopUpdaterChannelPolicy {
  readonly allowPrerelease: boolean;
  readonly releaseChannel: ReleaseTrack;
  readonly updateChannel: "latest" | Exclude<ReleaseTrack, "stable">;
}

export function resolveDesktopUpdaterChannelPolicy(
  installedVersion: string,
): DesktopUpdaterChannelPolicy {
  const identity = resolveDesktopReleaseIdentity(installedVersion);
  return {
    allowPrerelease: identity.channel !== "stable",
    releaseChannel: identity.channel,
    updateChannel: identity.updaterChannel,
  };
}

export function isUpdateVersionAllowed(
  policy: DesktopUpdaterChannelPolicy,
  offeredVersion: string,
): boolean {
  const offered = resolveReleaseVersion(offeredVersion);
  return offered?.channel === policy.releaseChannel;
}
