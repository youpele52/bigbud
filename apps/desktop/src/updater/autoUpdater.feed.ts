import type { AppUpdater } from "electron-updater";
import { resolveReleaseVersion } from "@bigbud/shared/releaseChannel";

import { readAppUpdateYml } from "../env/pathResolver";
import type { DesktopUpdaterChannelPolicy } from "./updaterChannelPolicy";

interface GitHubReleaseAsset {
  readonly name?: unknown;
}

interface GitHubRelease {
  readonly assets?: unknown;
  readonly draft?: unknown;
  readonly tag_name?: unknown;
}

interface UpdaterFeedDependencies {
  readonly fetch: typeof fetch;
  readonly platform: NodeJS.Platform;
  readonly readUpdateConfig: typeof readAppUpdateYml;
}

const defaultDependencies: UpdaterFeedDependencies = {
  fetch: globalThis.fetch,
  platform: process.platform,
  readUpdateConfig: readAppUpdateYml,
};

function githubToken(environment: NodeJS.ProcessEnv): string {
  return (
    environment.BIGBUD_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() ||
    environment.T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN?.trim() ||
    environment.GH_TOKEN?.trim() ||
    ""
  );
}

function updaterManifestName(
  updateChannel: DesktopUpdaterChannelPolicy["updateChannel"],
  platform: NodeJS.Platform,
): string {
  if (platform === "darwin") return `${updateChannel}-mac.yml`;
  if (platform === "linux") return `${updateChannel}-linux.yml`;
  return `${updateChannel}.yml`;
}

function hasAsset(release: GitHubRelease, expectedName: string): boolean {
  if (!Array.isArray(release.assets)) return false;
  return release.assets.some((asset: GitHubReleaseAsset) => asset && asset.name === expectedName);
}

export async function resolvePrereleaseGitHubFeedUrl({
  fetchImpl,
  owner,
  platform,
  releaseChannel,
  repo,
  token,
  updateChannel,
}: {
  readonly fetchImpl: typeof fetch;
  readonly owner: string;
  readonly platform: NodeJS.Platform;
  readonly releaseChannel: DesktopUpdaterChannelPolicy["releaseChannel"];
  readonly repo: string;
  readonly token: string;
  readonly updateChannel: DesktopUpdaterChannelPolicy["updateChannel"];
}): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=100`,
    { headers },
  );
  if (!response.ok) {
    throw new Error(`GitHub release lookup failed with HTTP ${response.status}.`);
  }
  const releases = (await response.json()) as unknown;
  if (!Array.isArray(releases)) {
    throw new Error("GitHub release lookup returned an invalid response.");
  }

  const expectedManifest = updaterManifestName(updateChannel, platform);
  for (const release of releases as GitHubRelease[]) {
    if (release.draft === true || typeof release.tag_name !== "string") continue;
    if (resolveReleaseVersion(release.tag_name)?.channel !== releaseChannel) continue;
    if (!hasAsset(release, expectedManifest)) {
      throw new Error(
        `Latest ${releaseChannel} release ${release.tag_name} is missing ${expectedManifest}.`,
      );
    }
    return `https://github.com/${owner}/${repo}/releases/download/${encodeURIComponent(release.tag_name)}/`;
  }

  throw new Error(`No published ${releaseChannel} release was found.`);
}

export function configureUpdaterFeed(
  updater: Pick<AppUpdater, "setFeedURL">,
  policy: DesktopUpdaterChannelPolicy,
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: UpdaterFeedDependencies = defaultDependencies,
): () => Promise<void> {
  if (environment.BIGBUD_DESKTOP_MOCK_UPDATES || environment.T3CODE_DESKTOP_MOCK_UPDATES) {
    updater.setFeedURL({
      provider: "generic",
      url: `http://localhost:${environment.BIGBUD_DESKTOP_MOCK_UPDATE_SERVER_PORT ?? environment.T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT ?? 3000}`,
    });
    return async () => {};
  }

  const updateConfig = dependencies.readUpdateConfig();
  if (updateConfig?.provider !== "github" || !updateConfig.owner || !updateConfig.repo) {
    return async () => {};
  }

  const { owner, repo } = updateConfig;
  const token = githubToken(environment);
  if (policy.releaseChannel === "stable") {
    if (token) {
      updater.setFeedURL({
        ...updateConfig,
        provider: "github" as const,
        private: true,
        token,
      });
    }
    return async () => {};
  }

  return async () => {
    const url = await resolvePrereleaseGitHubFeedUrl({
      fetchImpl: dependencies.fetch,
      owner,
      platform: dependencies.platform,
      releaseChannel: policy.releaseChannel,
      repo,
      token,
      updateChannel: policy.updateChannel,
    });
    updater.setFeedURL({ provider: "generic", url });
  };
}
