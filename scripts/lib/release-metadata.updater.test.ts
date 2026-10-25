import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveReleaseMetadata } from "./release-metadata.ts";

// Exercise the desktop's installed provider, not a reimplementation of its URL rules.
const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
interface UpdateInfo {
  readonly tag: string;
  readonly version: string;
}
const { GitHubProvider } = desktopRequire("electron-updater/out/providers/GitHubProvider.js") as {
  GitHubProvider: new (...args: unknown[]) => {
    getLatestVersion(): Promise<UpdateInfo>;
    resolveFiles(info: UpdateInfo): ReadonlyArray<{ readonly url: URL }>;
  };
};

describe("legacy release updater roundtrip", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ["darwin", "latest-mac.yml", "arm64.zip"],
    ["linux", "latest-linux.yml", "x64.AppImage"],
    ["win32", "latest.yml", "x64.exe"],
  ])(
    "keeps the source tag in %s manifest and artifact downloads",
    async (platform, manifest, suffix) => {
      vi.stubEnv("TEST_UPDATER_ARCH", "x64");
      const release = resolveReleaseMetadata("v0.3.00");
      const artifact = `bigbud-${release.version}-${suffix}`;
      const requests: string[] = [];
      const provider = new GitHubProvider(
        { provider: "github", owner: "youpele52", repo: "bigbud" },
        { allowPrerelease: false, currentVersion: "0.2.0", fullChangelog: false },
        {
          platform,
          executor: {
            request: async (options: { path: string }) => {
              requests.push(options.path);
              if (options.path.endsWith(".atom")) {
                return `<feed><entry><link href="https://github.com/youpele52/bigbud/releases/tag/${release.tag}"/><title>bigbud</title><content>Release</content></entry></feed>`;
              }
              if (options.path.endsWith("/latest"))
                return JSON.stringify({ tag_name: release.tag });
              expect(options.path).toBe(
                `/youpele52/bigbud/releases/download/${release.tag}/${manifest}`,
              );
              return `version: ${release.version}\nfiles:\n  - url: ${artifact}\n    sha512: Zml4dHVyZQ==\n    size: 7\n`;
            },
          },
        },
      );
      const info = await provider.getLatestVersion();
      expect(info.version).toBe("0.3.0");
      expect(info.tag).toBe("v0.3.00");
      expect(provider.resolveFiles(info).map((file) => file.url.href)).toEqual([
        `https://github.com/youpele52/bigbud/releases/download/v0.3.00/${artifact}`,
      ]);
      expect(requests).toHaveLength(3);
    },
  );
});
