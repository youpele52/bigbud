import { DOWNLOAD_BUTTON_LABELS, RELEASE_ASSET_SUFFIXES } from "../../../constants/downloads";
import { fetchLatestRelease } from "../../../lib/releases";

type Platform = { os: "mac" | "win" | "linux" };
function detectPlatform(): Platform | null {
  const ua = navigator.userAgent;
  if (/Win/i.test(ua)) return { os: "win" };
  if (/Mac/i.test(ua)) return { os: "mac" };
  if (/Linux/i.test(ua)) return { os: "linux" };
  return null;
}

async function pickAssetUrl(
  release: { assets: Array<{ name: string; browser_download_url: string }> },
  platform: Platform,
): Promise<string | null> {
  if (platform.os === "mac") {
    return "/download";
  }

  if (platform.os === "win") {
    const match = release.assets.find((asset) =>
      asset.name.endsWith(`-${RELEASE_ASSET_SUFFIXES.windowsX64}`),
    );
    return match?.browser_download_url ?? null;
  }

  if (platform.os === "linux") {
    const match = release.assets.find((asset) =>
      asset.name.endsWith(`.${RELEASE_ASSET_SUFFIXES.linuxAppImage}`),
    );
    return match?.browser_download_url ?? null;
  }

  return null;
}

export async function initHomeHero(): Promise<void> {
  const btn = document.getElementById("download-btn") as HTMLAnchorElement | null;
  if (!btn) return;

  const platform = detectPlatform();
  if (!platform) return;

  document.documentElement.dataset.platform = platform.os;
  btn.setAttribute("aria-label", DOWNLOAD_BUTTON_LABELS[platform.os]);

  try {
    const release = await fetchLatestRelease();
    const assetUrl = await pickAssetUrl(release, platform);

    if (assetUrl) {
      btn.href = assetUrl;
      if (platform.os !== "mac") {
        // Open direct downloads in a new tab to avoid navigating away from the marketing site.
        btn.target = "_blank";
        btn.rel = "noopener noreferrer";
      }
    } else {
      // Fallback to the download page if no matching asset is found
      btn.href = "/download";
    }
  } catch {
    // Keep the default /download link if fetching the release fails
    btn.href = "/download";
  }
}
