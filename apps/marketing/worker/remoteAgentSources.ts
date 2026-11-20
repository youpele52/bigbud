import type { RemoteAgentDownloadDeps } from "./remoteAgentDownload";
import {
  MAX_FEED_BYTES,
  parseReleaseFeedTags,
  remoteAgentReleasesFeedUrl,
} from "./remoteAgentFeed";
import {
  MAX_RELEASE_PAGES,
  isFullReleasePage,
  parseReleaseSummaries,
  rankChannelTags,
  remoteAgentDownloadLocation,
  remoteAgentReleasesApiUrl,
  selectRelease,
  type DownloadChannel,
  type ReleaseSummary,
} from "./remoteAgentRelease";

/**
 * Release sources for channel links. The REST API is tried first: it is authoritative (draft and
 * prerelease flags, asset lists, 300 releases deep) and fails fast when rate limited. Without a
 * token, Cloudflare's shared egress IPs often exhaust its 60 requests per hour, so the public
 * releases Atom feed, which has no API rate limit, answers instead. Each source returns a tag,
 * `NO_RELEASE` (only from a complete API listing), or `null` when it could not answer.
 */

type SourceDeps = Pick<RemoteAgentDownloadDeps, "env" | "fetch">;

/** Resolution for "this channel has no release that ships the script". */
export const NO_RELEASE = "none";
export const GITHUB_API_TIMEOUT_MS = 5_000;
export const RELEASE_FEED_TIMEOUT_MS = 5_000;
export const ASSET_PROBE_TIMEOUT_MS = 3_000;
/** Newest feed tags of the channel checked for the script before giving up. */
export const MAX_ASSET_PROBES = 3;
const USER_AGENT = "bigbud-download";

/**
 * Reads a bounded number of API pages so a quiet channel is still found behind newer releases of
 * another one. A failed or rate-limited page never turns into "no release".
 */
async function fetchApiResolution(
  deps: SourceDeps,
  channel: DownloadChannel,
): Promise<string | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
  const token = deps.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const signal = AbortSignal.timeout(GITHUB_API_TIMEOUT_MS);
  const releases: ReleaseSummary[] = [];
  try {
    for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
      const response = await deps.fetch(remoteAgentReleasesApiUrl(page), { headers, signal });
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) return null;
      releases.push(...parseReleaseSummaries(payload));
      if (!isFullReleasePage(payload.length)) break;
    }
  } catch {
    return null;
  }
  return selectRelease(channel, releases) ?? NO_RELEASE;
}

/** The body as text, or `null` when it is larger than `maxBytes`. */
async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  if (Number(response.headers.get("Content-Length")) > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchFeedTags(deps: SourceDeps): Promise<string[] | null> {
  try {
    const response = await deps.fetch(remoteAgentReleasesFeedUrl(), {
      headers: { Accept: "application/atom+xml", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(RELEASE_FEED_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const xml = await readBoundedText(response, MAX_FEED_BYTES);
    return xml === null ? null : parseReleaseFeedTags(xml);
  } catch {
    return null;
  }
}

function isReleaseAssetRedirect(location: string | null): boolean {
  if (!location) return false;
  try {
    const url = new URL(location);
    return url.protocol === "https:" && url.hostname.endsWith(".githubusercontent.com");
  } catch {
    return false;
  }
}

type AssetProbe = "present" | "missing" | "unknown";

/** GitHub answers a release download with a redirect to its asset host, or 404 without it. */
async function probeRemoteAgentAsset(deps: SourceDeps, location: string): Promise<AssetProbe> {
  try {
    const response = await deps.fetch(location, {
      method: "HEAD",
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(ASSET_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    if (response.status === 404) return "missing";
    if (response.status === 200) return "present";
    const isRedirect = response.status >= 300 && response.status < 400;
    return isRedirect && isReleaseAssetRedirect(response.headers.get("Location"))
      ? "present"
      : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * The feed lists tags (drafts never appear) without assets, so the channel's newest tags are
 * checked for the script, newest first. The feed only holds recent entries, so not finding one is
 * never "no release"; an inconclusive check stops rather than serving an older release.
 */
async function fetchFeedResolution(
  deps: SourceDeps,
  channel: DownloadChannel,
): Promise<string | null> {
  const tags = await fetchFeedTags(deps);
  if (!tags) return null;
  for (const tag of rankChannelTags(channel, tags).slice(0, MAX_ASSET_PROBES)) {
    const location = remoteAgentDownloadLocation(tag);
    if (!location) continue;
    const probe = await probeRemoteAgentAsset(deps, location);
    if (probe === "present") return tag;
    if (probe === "unknown") return null;
  }
  return null;
}

export async function resolveChannelRelease(
  deps: SourceDeps,
  channel: DownloadChannel,
): Promise<string | null> {
  return (await fetchApiResolution(deps, channel)) ?? fetchFeedResolution(deps, channel);
}
