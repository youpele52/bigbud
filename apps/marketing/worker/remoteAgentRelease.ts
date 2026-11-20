import {
  compareReleaseVersions,
  RELEASE_CHANNELS,
  resolveReleaseVersion,
  type ReleaseChannel,
} from "../../../packages/shared/src/releaseChannel.ts";
import { GITHUB_REPO_SLUG } from "../src/constants/app";

/**
 * Pure release resolution for `/download/<ref>/remote-agent`. No Workers globals. Release tags use
 * the one shared bigbud version format (`resolveReleaseVersion`), so every version the app pins in
 * a manual command resolves here.
 */

export const REMOTE_AGENT_SCRIPT_ASSET = "remote-agent.sh";
const RELEASES_PER_PAGE = 100;
/** Bounded paging: enough history to find the newest release of a quiet channel. */
export const MAX_RELEASE_PAGES = 3;

export function remoteAgentReleasesApiUrl(page: number): string {
  return `https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`;
}

export function isFullReleasePage(count: number): boolean {
  return count >= RELEASES_PER_PAGE;
}

export type DownloadChannel = "stable" | ReleaseChannel;

export type DownloadRef =
  | { readonly kind: "tag"; readonly tag: string }
  | { readonly kind: "channel"; readonly channel: DownloadChannel };

export interface ReleaseSummary {
  readonly tag: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assetNames: readonly string[];
}

const MAX_REF_LENGTH = 64;
const STABLE_ALIASES = new Set(["latest", "stable"]);

function resolveTag(value: string) {
  if (value.length === 0 || value.length > MAX_REF_LENGTH || value !== value.trim()) return null;
  return resolveReleaseVersion(value);
}

/** Returns the `v`-prefixed tag, or `null` when the value is not a bigbud release tag. */
export function normalizeReleaseTag(value: string): string | null {
  const resolved = resolveTag(value);
  return resolved ? `v${resolved.version}` : null;
}

export function parseDownloadRef(ref: string): DownloadRef | null {
  if (STABLE_ALIASES.has(ref)) return { kind: "channel", channel: "stable" };
  const channel = RELEASE_CHANNELS.find((candidate) => candidate === ref);
  if (channel) return { kind: "channel", channel };
  const tag = normalizeReleaseTag(ref);
  return tag ? { kind: "tag", tag } : null;
}

function releaseChannelOf(tag: string): DownloadChannel | null {
  return resolveTag(tag)?.channel ?? null;
}

export function compareReleaseTags(left: string, right: string): number {
  return compareReleaseVersions(left, right);
}

function qualifies(release: ReleaseSummary, channel: DownloadChannel): boolean {
  if (release.draft) return false;
  if (!release.assetNames.includes(REMOTE_AGENT_SCRIPT_ASSET)) return false;
  if (releaseChannelOf(release.tag) !== channel) return false;
  return channel === "stable" ? !release.prerelease : release.prerelease;
}

/** Newest qualifying release tag of exactly this channel. Never falls back across channels. */
export function selectRelease(
  channel: DownloadChannel,
  releases: readonly ReleaseSummary[],
): string | null {
  let newest: string | null = null;
  for (const release of releases) {
    if (!qualifies(release, channel)) continue;
    const tag = normalizeReleaseTag(release.tag);
    if (tag && (newest === null || compareReleaseTags(tag, newest) > 0)) newest = tag;
  }
  return newest;
}

/**
 * Distinct valid tags of exactly this channel, newest first, for sources that list bare tags
 * without release flags or assets (the releases Atom feed). Never falls back across channels.
 */
export function rankChannelTags(channel: DownloadChannel, tags: readonly string[]): string[] {
  const ranked = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeReleaseTag(tag);
    if (normalized && releaseChannelOf(normalized) === channel) ranked.add(normalized);
  }
  return [...ranked].toSorted((left, right) => compareReleaseTags(right, left));
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Defensive parse of the GitHub releases API payload. Malformed entries are dropped. */
export function parseReleaseSummaries(payload: unknown): ReleaseSummary[] {
  if (!Array.isArray(payload)) return [];
  const summaries: ReleaseSummary[] = [];
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const tag = readString(record.tag_name);
    if (!tag || !Array.isArray(record.assets)) continue;
    const assetNames = record.assets.flatMap((asset: unknown) => {
      const name =
        typeof asset === "object" && asset !== null
          ? readString((asset as Record<string, unknown>).name)
          : null;
      return name ? [name] : [];
    });
    summaries.push({
      tag,
      draft: record.draft === true,
      prerelease: record.prerelease === true,
      assetNames,
    });
  }
  return summaries;
}

/** The only redirect target. The tag is re-validated, including tags that came from the API. */
export function remoteAgentDownloadLocation(tag: string): string | null {
  const normalized = normalizeReleaseTag(tag);
  if (!normalized) return null;
  return `https://github.com/${GITHUB_REPO_SLUG}/releases/download/${normalized}/${REMOTE_AGENT_SCRIPT_ASSET}`;
}
