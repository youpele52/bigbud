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

/**
 * Tailscale Serve HTTPS port per desktop channel, the single source for every
 * consumer. A machine has one tailnet HTTPS hostname, so channels sharing "/" on
 * one port would overwrite each other; a distinct port lets stable, prereleases
 * and local development serve at once. Stable keeps 443 so existing pairing
 * links (`https://<host>/`) stay valid.
 *
 * Tailnet-only Serve accepts any TCP port for `--https=<port>` (the CLI only
 * bounds it to uint16: tailscale `cmd/tailscale/cli/serve_v2.go`,
 * `srvTypeAndPortFromFlags`). Only Funnel is limited to 443, 8443 and 10000
 * (tailscale.com/kb/1223/funnel, `ipn.CheckFunnelPort`), and bigbud never
 * enables Funnel.
 */
export const TAILSCALE_SERVE_HTTPS_PORTS = {
  stable: 443,
  beta: 8443,
  preview: 9443,
  nightly: 10443,
  development: 10000,
} as const satisfies Record<ReleaseTrack | "development", number>;

/** Local development builds share the stable identity, so they need their own port. */
export function resolveTailscaleServeHttpsPort(input: {
  readonly channel: ReleaseTrack;
  readonly development: boolean;
}): number {
  return input.development
    ? TAILSCALE_SERVE_HTTPS_PORTS.development
    : TAILSCALE_SERVE_HTTPS_PORTS[input.channel];
}
