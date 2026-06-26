const GITHUB_REPO_SLUG = "youpele52/bigbud";
const REPO = GITHUB_REPO_SLUG;
const PER_PAGE = 100;
const MAX_PAGES = 5;

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

async function fetchPage(page: number): Promise<GitHubRelease[]> {
  const url = `https://api.github.com/repos/${REPO}/releases?per_page=${PER_PAGE}&page=${page}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GitHub API error (page ${page}): ${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<GitHubRelease[]>;
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

const flags = process.argv.slice(2);
const stats = await fetchDownloadStats();

if (flags.includes("--write")) {
  await writePublicJson(stats);
} else {
  console.log(JSON.stringify(stats, null, 2));
}
