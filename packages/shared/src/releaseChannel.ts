export const RELEASE_CHANNELS = ["beta", "preview", "nightly"] as const;
export const RELEASE_TRACKS = ["stable", ...RELEASE_CHANNELS] as const;

export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];
export type ReleaseTrack = (typeof RELEASE_TRACKS)[number];

export interface ResolvedReleaseVersion {
  readonly channel: ReleaseTrack;
  readonly isPrerelease: boolean;
  readonly version: string;
}

const RELEASE_CHANNEL_LABELS: Record<ReleaseChannel, string> = {
  beta: "Beta",
  preview: "Preview",
  nightly: "Nightly",
};

const RELEASE_VERSION_PATTERN =
  /^v?(?<core>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-(?<channel>beta|preview|nightly)(?<suffix>(?:[.-][0-9A-Za-z]+)*))?$/;

export function resolveReleaseVersion(input: string): ResolvedReleaseVersion | null {
  const match = RELEASE_VERSION_PATTERN.exec(input.trim());
  if (!match?.groups?.core) return null;

  const channel = match.groups.channel as ReleaseChannel | undefined;
  const suffix = match.groups.suffix ?? "";
  if (
    channel &&
    `${channel}${suffix}`
      .split(".")
      .some(
        (identifier) =>
          identifier.length > 1 && /^\d+$/.test(identifier) && identifier.startsWith("0"),
      )
  ) {
    return null;
  }
  return {
    channel: channel ?? "stable",
    isPrerelease: channel !== undefined,
    version: channel ? `${match.groups.core}-${channel}${suffix}` : match.groups.core,
  };
}

export function resolveReleaseChannel(version: string): ReleaseChannel | null {
  const resolved = resolveReleaseVersion(version);
  return resolved?.channel === "stable" ? null : (resolved?.channel ?? null);
}

export function releaseChannelLabel(channel: ReleaseChannel): string {
  return RELEASE_CHANNEL_LABELS[channel];
}
