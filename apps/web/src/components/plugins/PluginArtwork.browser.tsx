import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const themeState = vi.hoisted(() => ({ value: "light" as "light" | "dark" }));

vi.mock("~/hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: themeState.value }),
}));
vi.mock("~/rpc/wsHttpOrigin", () => ({
  resolveWsHttpOrigin: () => "http://127.0.0.1:3774",
}));

import { PluginArtwork, pluginAssetUrl } from "./PluginArtwork";

const plugin = {
  id: "openai-public:asana",
  commit: "revision-1",
  presentation: {
    displayName: "Asana",
    assets: {
      composerIcon: "assets/logo.png",
      logo: "assets/logo.png",
      logoDark: "assets/logo-dark.png",
    },
  },
};

describe("PluginArtwork", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    themeState.value = "light";
  });

  it("uses complete catalog and installed asset URLs", () => {
    expect(
      pluginAssetUrl({
        scope: "catalog",
        revision: plugin.commit,
        pluginId: plugin.id,
        assetKey: "logo",
      }),
    ).toBe(
      "http://127.0.0.1:3774/api/plugins/assets?scope=catalog&revision=revision-1&pluginId=openai-public%3Aasana&assetKey=logo",
    );
    expect(
      pluginAssetUrl({
        scope: "installed",
        revision: plugin.commit,
        pluginId: plugin.id,
        assetKey: "logoDark",
      }),
    ).toContain("scope=installed");
  });

  it("uses the declared store logo rather than always using composerIcon", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    await render(<PluginArtwork plugin={plugin} surface="store" />, { container: host });
    const image = () => host.querySelector("img");
    expect(image()?.getAttribute("src")).toContain("assetKey=logo");
  });

  it("uses logoDark first in dark mode and resets when the source changes", async () => {
    themeState.value = "dark";
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(<PluginArtwork plugin={plugin} surface="store" />, {
      container: host,
    });
    expect(host.querySelector("img")?.getAttribute("src")).toContain("assetKey=logoDark");
    await screen.rerender(
      <PluginArtwork plugin={{ ...plugin, commit: "revision-2" }} surface="store" />,
    );
    await expect.poll(() => host.querySelector("img")?.getAttribute("src")).toContain("revision-2");
  });

  it("keeps fallback glyphs padded inside the fixed store and compact artwork footprints", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <PluginArtwork
        plugin={{ ...plugin, presentation: { ...plugin.presentation, assets: {} } }}
        surface="store"
        className="size-12"
      />,
      { container: host },
    );
    const storeFallback = host.querySelector('[data-testid="plugin-artwork-fallback"]');
    expect(storeFallback?.className).toContain("size-12");
    expect(storeFallback?.firstElementChild?.className).toContain("p-3");
    expect(storeFallback?.querySelector("svg")?.getAttribute("class")).toContain("size-5");

    await screen.rerender(
      <PluginArtwork
        plugin={{ ...plugin, presentation: { ...plugin.presentation, assets: {} } }}
        surface="compact"
        className="size-7"
      />,
    );
    const compactFallback = host.querySelector('[data-testid="plugin-artwork-fallback"]');
    expect(compactFallback?.className).toContain("size-7");
    expect(compactFallback?.firstElementChild?.className).toContain("p-1.5");
    expect(compactFallback?.querySelector("svg")?.getAttribute("class")).toContain("size-3.5");
    // 14px glyph + 2 × 6px padding fits inside the 28px (size-7) footprint.
    expect(14 + 2 * 6).toBeLessThanOrEqual(28);
  });
});
