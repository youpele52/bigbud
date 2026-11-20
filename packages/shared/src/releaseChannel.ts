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
  beta: "beta",
  preview: "preview",
  nightly: "nightly",
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

function prereleaseIdentifiers(version: string): string[] {
  const separator = version.indexOf("-");
  return separator < 0 ? [] : version.slice(separator + 1).split(".");
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semver precedence of two release versions accepted by `resolveReleaseVersion` (with or
 * without the leading `v`); a stable release ranks above its own prereleases. Download links,
 * the release job and the app's pinned commands all use this one version format.
 */
export function compareReleaseVersions(left: string, right: string): number {
  const a = resolveReleaseVersion(left);
  const b = resolveReleaseVersion(right);
  if (!a || !b) throw new Error("Not a bigbud release version.");
  const coreA = a.version.split("-")[0]!.split(".").map(Number);
  const coreB = b.version.split("-")[0]!.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = coreA[index]! - coreB[index]!;
    if (difference !== 0) return difference;
  }
  const preA = prereleaseIdentifiers(a.version);
  const preB = prereleaseIdentifiers(b.version);
  if (preA.length === 0 || preB.length === 0) return preB.length - preA.length;
  for (let index = 0; index < Math.min(preA.length, preB.length); index += 1) {
    const difference = compareIdentifier(preA[index]!, preB[index]!);
    if (difference !== 0) return difference;
  }
  return preA.length - preB.length;
}
