import { describe, expect, it, vi } from "vitest";

import { configureUpdaterFeed } from "./autoUpdater.feed";
import { resolveDesktopUpdaterChannelPolicy } from "./updaterChannelPolicy";

function response(body: unknown, status = 200): Response {
  return {
    json: async () => body,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

function dependencies(fetchImpl: typeof fetch, platform: NodeJS.Platform = "darwin") {
  return {
    fetch: fetchImpl,
    platform,
    readUpdateConfig: () => ({ provider: "github", owner: "youpele52", repo: "bigbud" }),
  };
}

describe("desktop updater feed", () => {
  it("keeps authenticated Stable updates on the private GitHub provider", async () => {
    const setFeedURL = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>();
    const prepare = configureUpdaterFeed(
      { setFeedURL },
      resolveDesktopUpdaterChannelPolicy("1.2.3"),
      { BIGBUD_DESKTOP_UPDATE_GITHUB_TOKEN: "secret" },
      dependencies(fetchImpl),
    );

    expect(setFeedURL).toHaveBeenCalledWith({
      owner: "youpele52",
      private: true,
      provider: "github",
      repo: "bigbud",
      token: "secret",
    });
    await prepare();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["1.2.3-beta.1", "beta", "beta-mac.yml"],
    ["1.2.3-preview.1", "preview", "preview-mac.yml"],
    ["1.2.3-nightly.1", "nightly", "nightly-mac.yml"],
  ] as const)("resolves an isolated GitHub feed for %s", async (version, channel, manifest) => {
    const setFeedURL = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response([
        { assets: [{ name: "latest-mac.yml" }], tag_name: "v1.2.4" },
        { assets: [{ name: "preview-mac.yml" }], tag_name: "v1.2.4-preview.2" },
        { assets: [{ name: manifest }], tag_name: `v1.2.4-${channel}.2` },
      ]),
    );
    const prepare = configureUpdaterFeed(
      { setFeedURL },
      resolveDesktopUpdaterChannelPolicy(version),
      { GH_TOKEN: "secret" },
      dependencies(fetchImpl),
    );

    expect(setFeedURL).not.toHaveBeenCalled();
    await prepare();

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/youpele52/bigbud/releases?per_page=100",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
      }),
    );
    expect(setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: `https://github.com/youpele52/bigbud/releases/download/v1.2.4-${channel}.2/`,
    });
  });

  it("fails closed when the latest same-channel release has no platform manifest", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response([{ assets: [], tag_name: "v1.2.4-beta.2" }]));
    const prepare = configureUpdaterFeed(
      { setFeedURL: vi.fn() },
      resolveDesktopUpdaterChannelPolicy("1.2.3-beta.1"),
      {},
      dependencies(fetchImpl),
    );

    await expect(prepare()).rejects.toThrow(
      "Latest beta release v1.2.4-beta.2 is missing beta-mac.yml.",
    );
  });

  it("keeps mock updates independent of GitHub release discovery", async () => {
    const setFeedURL = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>();
    const prepare = configureUpdaterFeed(
      { setFeedURL },
      resolveDesktopUpdaterChannelPolicy("1.2.3-preview.1"),
      { BIGBUD_DESKTOP_MOCK_UPDATES: "1", BIGBUD_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4321" },
      dependencies(fetchImpl),
    );

    expect(setFeedURL).toHaveBeenCalledWith({
      provider: "generic",
      url: "http://localhost:4321",
    });
    await prepare();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
