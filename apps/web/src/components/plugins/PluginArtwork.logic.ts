import type { PluginAssetKey } from "@bigbud/contracts";

export type PluginArtworkSurface = "store" | "compact";
export type ResolvedTheme = "light" | "dark";

interface PluginArtworkAssets {
  readonly composerIcon?: string | undefined;
  readonly logo?: string | undefined;
  readonly logoDark?: string | undefined;
}

export function pluginArtworkAssetKeys(
  surface: PluginArtworkSurface,
  theme: ResolvedTheme,
  assets: PluginArtworkAssets,
): ReadonlyArray<PluginAssetKey> {
  const candidates: ReadonlyArray<PluginAssetKey> =
    surface === "compact"
      ? ["composerIcon"]
      : theme === "dark"
        ? ["logoDark", "logo", "composerIcon"]
        : ["logo", "composerIcon", "logoDark"];
  const seenPaths = new Set<string>();
  return candidates.filter((key) => {
    const path = assets[key];
    if (path === undefined || seenPaths.has(path)) return false;
    seenPaths.add(path);
    return true;
  });
}

export function nextPluginArtworkAssetIndex(currentIndex: number): number {
  return currentIndex + 1;
}
