import { writeFile } from "node:fs/promises";

/** A published GitHub release asset, addressed by repository, tag and file name. */
export interface GitHubReleaseAssetRef {
  readonly repository: string;
  readonly tag: string;
  readonly assetName: string;
}

export interface GitHubReleaseAssetDownloadOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Attempts against the public download URL before falling back to the REST API. */
  readonly attempts?: number;
  readonly retryDelayMs?: number;
  /** Defaults to `GITHUB_TOKEN`, then `GH_TOKEN`; only sent to api.github.com. */
  readonly token?: string;
  readonly log?: (message: string) => void;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2_000;

export function gitHubReleaseAssetUrl(ref: GitHubReleaseAssetRef): string {
  return `https://github.com/${ref.repository}/releases/download/${ref.tag}/${ref.assetName}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function fetchBytes(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
): Promise<Buffer> {
  const response = await fetchImpl(url, { headers, redirect: "follow" });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchViaApi(
  fetchImpl: typeof globalThis.fetch,
  ref: GitHubReleaseAssetRef,
  token: string | undefined,
): Promise<Buffer> {
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const releaseUrl = `https://api.github.com/repos/${ref.repository}/releases/tags/${encodeURIComponent(ref.tag)}`;
  const response = await fetchImpl(releaseUrl, {
    headers: { Accept: "application/vnd.github+json", ...auth },
  });
  if (!response.ok) throw new Error(`${releaseUrl} returned HTTP ${response.status}`);
  const release = (await response.json()) as {
    readonly assets?: ReadonlyArray<{ readonly name?: unknown; readonly url?: unknown }>;
  };
  const asset = release.assets?.find((candidate) => candidate.name === ref.assetName);
  if (typeof asset?.url !== "string") {
    throw new Error(`Release ${ref.repository}@${ref.tag} has no asset '${ref.assetName}'.`);
  }
  return fetchBytes(fetchImpl, asset.url, { Accept: "application/octet-stream", ...auth });
}

/**
 * Downloads a release asset to `destination`. The public download URL is retried with
 * backoff, then the REST API asset endpoint is used: github.com's download front end can
 * return 504s for one large asset for an extended period while the API still serves it.
 * Callers must still verify the content (for example a pinned SHA-256).
 */
export async function downloadGitHubReleaseAsset(
  ref: GitHubReleaseAssetRef,
  destination: string,
  options: GitHubReleaseAssetDownloadOptions = {},
): Promise<void> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  const url = gitHubReleaseAssetUrl(ref);
  const failures: Array<string> = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await writeFile(destination, await fetchBytes(fetchImpl, url, {}));
      return;
    } catch (error) {
      failures.push(`attempt ${attempt}: ${error instanceof Error ? error.message : error}`);
      options.log?.(`Download of ${url} failed (${failures.at(-1)}).`);
      if (attempt < attempts) await sleep(retryDelayMs * attempt);
    }
  }

  options.log?.(`Falling back to the GitHub API for ${ref.assetName}.`);
  try {
    await writeFile(destination, await fetchViaApi(fetchImpl, ref, token));
  } catch (error) {
    failures.push(`api: ${error instanceof Error ? error.message : error}`);
    throw new Error(`Could not download ${url}: ${failures.join("; ")}`, { cause: error });
  }
}
