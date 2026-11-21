import { GITHUB_RELEASES_URL } from "../src/constants/app";
import {
  parseDownloadRef,
  remoteAgentDownloadLocation,
  type DownloadChannel,
} from "./remoteAgentRelease";
import { NO_RELEASE, resolveChannelRelease } from "./remoteAgentSources";

/** Request handling for `/download/<ref>/remote-agent`, with injected platform services. */

export interface RemoteAgentDownloadEnv {
  readonly GITHUB_TOKEN?: string;
}

export interface RemoteAgentDownloadDeps {
  readonly env: RemoteAgentDownloadEnv;
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly cache: Pick<Cache, "match" | "put">;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

export const CHANNEL_CACHE_SECONDS = 300;
export const LAST_GOOD_CACHE_SECONDS = 7 * 24 * 60 * 60;
export const PINNED_REDIRECT_CACHE_SECONDS = 24 * 60 * 60;
const CACHE_KEY_BASE = "https://bigbud.app/__cache/remote-agent";
const BETA_DOWNLOAD_URL = "https://bigbud.app/download/beta/remote-agent";

function textResponse(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function redirectResponse(location: string, maxAgeSeconds: number): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": `public, max-age=${maxAgeSeconds}` },
  });
}

function noReleaseMessage(channel: DownloadChannel): string {
  if (channel === "stable") {
    return `No stable bigbud release ships the remote agent script yet. Use ${BETA_DOWNLOAD_URL} instead.`;
  }
  return `No bigbud ${channel} release ships the remote agent script yet.`;
}

/** Plain text for a channel lookup that neither source could answer and nothing cached. */
function lookupFailedMessage(channel: DownloadChannel): string {
  const lines = [
    `Could not look up the newest bigbud ${channel} release. Retry shortly or use a pinned link such as /download/v<version>/remote-agent.`,
  ];
  if (channel === "stable") lines.push(`Stable releases: ${GITHUB_RELEASES_URL}/latest`);
  lines.push(`Beta and prereleases: ${GITHUB_RELEASES_URL}`);
  return lines.join("\n");
}

function cacheKeys(channel: DownloadChannel) {
  return {
    fresh: `${CACHE_KEY_BASE}/${channel}`,
    lastGood: `${CACHE_KEY_BASE}/${channel}/last-good`,
  };
}

async function readCached(deps: RemoteAgentDownloadDeps, key: string): Promise<string | null> {
  try {
    const cached = await deps.cache.match(key);
    return cached ? (await cached.text()).trim() : null;
  } catch {
    return null;
  }
}

function storeCached(deps: RemoteAgentDownloadDeps, key: string, value: string, seconds: number) {
  const response = new Response(value, {
    headers: { "Content-Type": "text/plain", "Cache-Control": `public, max-age=${seconds}` },
  });
  deps.waitUntil(deps.cache.put(key, response).catch(() => undefined));
}

function resolutionResponse(channel: DownloadChannel, resolution: string): Response {
  if (resolution === NO_RELEASE) return textResponse(404, noReleaseMessage(channel));
  const location = remoteAgentDownloadLocation(resolution);
  return location
    ? redirectResponse(location, CHANNEL_CACHE_SECONDS)
    : textResponse(404, noReleaseMessage(channel));
}

export async function handleRemoteAgentDownload(
  rawRef: unknown,
  deps: RemoteAgentDownloadDeps,
): Promise<Response> {
  const ref = typeof rawRef === "string" ? parseDownloadRef(rawRef) : null;
  if (!ref) {
    return textResponse(
      404,
      "Unknown download. Use latest, stable, beta, preview, nightly or a release tag such as v0.4.0.",
    );
  }
  if (ref.kind === "tag") {
    const location = remoteAgentDownloadLocation(ref.tag);
    return location
      ? redirectResponse(location, PINNED_REDIRECT_CACHE_SECONDS)
      : textResponse(404, "Unknown release tag.");
  }

  const keys = cacheKeys(ref.channel);
  const fresh = await readCached(deps, keys.fresh);
  if (fresh) return resolutionResponse(ref.channel, fresh);

  const resolved = await resolveChannelRelease(deps, ref.channel);
  if (resolved) {
    storeCached(deps, keys.fresh, resolved, CHANNEL_CACHE_SECONDS);
    // The long-lived fallback only ever holds a real release, never "none".
    if (resolved !== NO_RELEASE)
      storeCached(deps, keys.lastGood, resolved, LAST_GOOD_CACHE_SECONDS);
    return resolutionResponse(ref.channel, resolved);
  }

  const lastGood = await readCached(deps, keys.lastGood);
  if (lastGood) return resolutionResponse(ref.channel, lastGood);
  return textResponse(503, lookupFailedMessage(ref.channel));
}
