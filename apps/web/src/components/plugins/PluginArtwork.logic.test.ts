import { describe, expect, it } from "vitest";

import { nextPluginArtworkAssetIndex, pluginArtworkAssetKeys } from "./PluginArtwork.logic";

describe("pluginArtworkAssetKeys", () => {
  const assets = {
    composerIcon: "assets/composer.png",
    logo: "assets/logo.png",
    logoDark: "assets/logo-dark.png",
  };

  it("uses full logo surfaces in light and dark store contexts", () => {
    expect(pluginArtworkAssetKeys("store", "light", assets)).toEqual([
      "logo",
      "composerIcon",
      "logoDark",
    ]);
    expect(pluginArtworkAssetKeys("store", "dark", assets)).toEqual([
      "logoDark",
      "logo",
      "composerIcon",
    ]);
  });

  it("keeps compact contexts on the composer icon and avoids duplicate shared-logo requests", () => {
    expect(
      pluginArtworkAssetKeys("compact", "light", {
        composerIcon: "assets/logo.png",
        logo: "assets/logo.png",
      }),
    ).toEqual(["composerIcon"]);
    expect(
      pluginArtworkAssetKeys("store", "light", {
        composerIcon: "assets/logo.png",
        logo: "assets/logo.png",
      }),
    ).toEqual(["logo"]);
  });

  it("advances through each declared fallback after an image error", () => {
    const candidates = pluginArtworkAssetKeys("store", "light", assets);
    expect(candidates[nextPluginArtworkAssetIndex(0)]).toBe("composerIcon");
    expect(candidates[nextPluginArtworkAssetIndex(1)]).toBe("logoDark");
    expect(candidates[nextPluginArtworkAssetIndex(2)]).toBeUndefined();
  });
});
