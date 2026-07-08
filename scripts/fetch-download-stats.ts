const GITHUB_REPO_SLUG = "youpele52/bigbud";
const REPO = GITHUB_REPO_SLUG;
const PER_PAGE = 100;
const MAX_PAGES = 5;
const DOWNLOAD_STATS_PATH = new URL(
  "../apps/marketing/public/data/downloads.json",
  import.meta.url,
);
const GITHUB_TOKEN =
  process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_API_TOKEN;

interface GitHubAsset {
  name: string;
  download_count: number;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
  draft?: boolean;
  prerelease?: boolean;
}

export interface DownloadStats {
  repo: string;
  fetchedAt: string;
  totalInstallers: number;
  totalAllAssets: number;
  installerPattern: string;
  perPage: number;
  pagesFetched: number;
}

const INSTALLER_RE = /\.(dmg|zip|exe|AppImage|deb)$/;
const PUBLIC_DATA_DIR = new URL("../apps/marketing/public/data/", import.meta.url);

const REQUEST_HEADERS = {
  "User-Agent": "bigbud-download-stats",
  ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
};

async function fetchPage(page: number): Promise<GitHubRelease[]> {
  const url = `https://api.github.com/repos/${REPO}/releases?per_page=${PER_PAGE}&page=${page}`;
  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    throw new Error(`GitHub API error (page ${page}): ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<GitHubRelease[]>;
}

function isDownloadStats(value: unknown): value is DownloadStats {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const stats = value as Partial<DownloadStats>;
  return (
    typeof stats.repo === "string" &&
    typeof stats.fetchedAt === "string" &&
    typeof stats.totalInstallers === "number" &&
    typeof stats.totalAllAssets === "number" &&
    typeof stats.installerPattern === "string" &&
    typeof stats.perPage === "number" &&
    typeof stats.pagesFetched === "number"
  );
}

async function readCachedDownloadStats(): Promise<DownloadStats | null> {
  try {
    const raw = await Bun.file(DOWNLOAD_STATS_PATH).text();
    const parsed = JSON.parse(raw) as unknown;
    return isDownloadStats(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function createFallbackDownloadStats(): DownloadStats {
  return {
    repo: REPO,
    fetchedAt: new Date().toISOString(),
    totalInstallers: 0,
    totalAllAssets: 0,
    installerPattern: INSTALLER_RE.source,
    perPage: PER_PAGE,
    pagesFetched: 0,
  };
}

export async function fetchDownloadStats(maxPages = MAX_PAGES): Promise<DownloadStats> {
  let allAssets = 0;
  let installers = 0;
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const releases = await fetchPage(page);
    if (!Array.isArray(releases) || releases.length === 0) break;
    pagesFetched++;

    for (const release of releases) {
      if (!Array.isArray(release.assets)) continue;
      for (const asset of release.assets) {
        allAssets += asset.download_count;
        if (INSTALLER_RE.test(asset.name)) {
          installers += asset.download_count;
        }
      }
    }
  }

  return {
    repo: REPO,
    fetchedAt: new Date().toISOString(),
    totalInstallers: installers,
    totalAllAssets: allAssets,
    installerPattern: INSTALLER_RE.source,
    perPage: PER_PAGE,
    pagesFetched,
  };
}

async function writePublicJson(stats: DownloadStats): Promise<void> {
  const outFile = new URL("downloads.json", PUBLIC_DATA_DIR);
  await Bun.write(outFile, JSON.stringify(stats, null, 2));
  console.log(`Wrote ${outFile}`);
}

async function resolveDownloadStats(): Promise<DownloadStats> {
  try {
    return await fetchDownloadStats();
  } catch (error) {
    const cachedStats = await readCachedDownloadStats();
    if (cachedStats) {
      console.warn(
        `Falling back to cached download stats after refresh failure: ${error instanceof Error ? error.message : String(error)}`,
      );
      return cachedStats;
    }

    console.warn(
      `Falling back to empty download stats after refresh failure: ${error instanceof Error ? error.message : String(error)}`,
    );
    return createFallbackDownloadStats();
  }
}

const flags = process.argv.slice(2);
const stats = await resolveDownloadStats();

if (flags.includes("--write")) {
  await writePublicJson(stats);
} else {
  console.log(JSON.stringify(stats, null, 2));
}
