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
  beta: createPrereleaseIdentity("beta", "Beta"),
  preview: createPrereleaseIdentity("preview", "Preview"),
  nightly: createPrereleaseIdentity("nightly", "Nightly"),
} as const satisfies Record<ReleaseTrack, DesktopReleaseIdentity>;

function createPrereleaseIdentity(
  channel: Exclude<ReleaseTrack, "stable">,
  label: string,
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
    productName: `bigbud ${label}`,
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
