export const RELEASE_CHANNELS = ["beta", "preview", "nightly"] as const;

export type ReleaseChannel = (typeof RELEASE_CHANNELS)[number];

const RELEASE_CHANNEL_LABELS: Record<ReleaseChannel, string> = {
  beta: "Beta",
  preview: "Preview",
  nightly: "Nightly",
};

const PRERELEASE_VERSION_PATTERN = /^v?\d+\.\d+\.\d+-(?<channel>[a-z]+)(?:[.-][0-9a-z.-]+)?$/i;

export function resolveReleaseChannel(version: string): ReleaseChannel | null {
  const channel = PRERELEASE_VERSION_PATTERN.exec(version.trim())?.groups?.channel?.toLowerCase();
  return RELEASE_CHANNELS.find((candidate) => candidate === channel) ?? null;
}

export function releaseChannelLabel(channel: ReleaseChannel): string {
  return RELEASE_CHANNEL_LABELS[channel];
}
