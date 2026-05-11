import { GITHUB_RELEASES_URL, GITHUB_REPO_SLUG } from "../constants/app";

export const RELEASES_URL = GITHUB_RELEASES_URL;

const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases/latest`;
const RELEASES_API_URL = `https://api.github.com/repos/${GITHUB_REPO_SLUG}/releases`;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface Release {
  tag_name: string;
  html_url: string;
  assets: ReleaseAsset[];
  draft?: boolean;
  prerelease?: boolean;
}

function isRelease(value: unknown): value is Release {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<Release>;
  return (
    typeof candidate.tag_name === "string" &&
    typeof candidate.html_url === "string" &&
    Array.isArray(candidate.assets)
  );
}

async function fetchReleaseCandidate(url: string): Promise<unknown | null> {
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

function pickFallbackRelease(value: unknown): Release | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const releases = value.filter(isRelease).filter((release) => !release.draft);
  return (
    releases.find((release) => !release.prerelease && release.assets.length > 0) ??
    releases[0] ??
    null
  );
}

export async function fetchLatestRelease(): Promise<Release> {
  const latestRelease = await fetchReleaseCandidate(LATEST_RELEASE_API_URL);
  if (isRelease(latestRelease) && latestRelease.assets.length > 0) {
    return latestRelease;
  }

  const releases = await fetchReleaseCandidate(RELEASES_API_URL);
  const fallbackRelease = pickFallbackRelease(releases);
  if (!fallbackRelease) {
    throw new Error("No GitHub releases are available.");
  }

  return fallbackRelease;
}
