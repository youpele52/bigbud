import { type ReleaseTrack, resolveReleaseVersion } from "@bigbud/shared/releaseChannel";

export interface DesktopReleaseIdentity {
  readonly appId: string;
  readonly appUserModelId: string;
  readonly baseDirSuffix: readonly string[];
  readonly channel: ReleaseTrack;
  readonly executableName: string;
  readonly linuxDesktopEntryName: string;
  readonly linuxWmClass: string;
  readonly packageName: string;
  readonly productName: string;
  readonly updaterChannel: "latest" | Exclude<ReleaseTrack, "stable">;
  readonly userDataDirName: string;
}

const IDENTITIES = {
  stable: {
    appId: "ai.bigbud.desktop",
    appUserModelId: "ai.bigbud.desktop",
    baseDirSuffix: [],
    channel: "stable",
    executableName: "bigbud",
    linuxDesktopEntryName: "bigbud.desktop",
    linuxWmClass: "bigbud",
    packageName: "bigbud-desktop",
    productName: "bigbud",
    updaterChannel: "latest",
    userDataDirName: "bigbud",
  },
  beta: createPrereleaseIdentity("beta"),
  preview: createPrereleaseIdentity("preview"),
  nightly: createPrereleaseIdentity("nightly"),
} as const satisfies Record<ReleaseTrack, DesktopReleaseIdentity>;

// Channel names are always lowercase in the product name, like the bigbud brand itself.
function createPrereleaseIdentity(
  channel: Exclude<ReleaseTrack, "stable">,
): DesktopReleaseIdentity {
  const executableName = `bigbud-${channel}`;
  const appId = `ai.bigbud.desktop.${channel}`;
  return {
    appId,
    appUserModelId: appId,
    baseDirSuffix: ["channels", channel],
    channel,
    executableName,
    linuxDesktopEntryName: `${executableName}.desktop`,
    linuxWmClass: executableName,
    packageName: `bigbud-desktop-${channel}`,
    productName: `bigbud ${channel}`,
    updaterChannel: channel,
    userDataDirName: executableName,
  };
}

export function desktopReleaseIdentityForChannel(channel: ReleaseTrack): DesktopReleaseIdentity {
  return IDENTITIES[channel];
}

export function resolveDesktopReleaseIdentity(version: string): DesktopReleaseIdentity {
  const release = resolveReleaseVersion(version);
  if (!release) {
    throw new Error(`Unsupported desktop release version: ${version}`);
  }
  return desktopReleaseIdentityForChannel(release.channel);
}
