import { DOWNLOAD_BUTTON_LABELS } from "../../../constants/downloads";
import { fetchLatestRelease } from "../../../lib/releases";

type Platform = { os: "mac" | "win" | "linux" };

function detectPlatform(): Platform | null {
  const ua = navigator.userAgent;
  if (/Win/i.test(ua)) return { os: "win" };
  if (/Mac/i.test(ua)) return { os: "mac" };
  if (/Linux/i.test(ua)) return { os: "linux" };
  return null;
}

function detectMacArch(): "arm64" | "x64" {
  // Modern Apple Silicon detection
  if (
    navigator.userAgent.includes("Mac") &&
    (navigator.userAgent.includes("arm64") || navigator.userAgent.includes("ARM"))
  ) {
    return "arm64";
  }

  // Fallback: use platform + cpu info if available
  if (
    typeof (navigator as unknown as { oscpu?: string }).oscpu === "string" &&
    (navigator as unknown as { oscpu: string }).oscpu.includes("ARM")
  ) {
    return "arm64";
  }

  return "x64";
}

function pickAssetUrl(
  release: { assets: Array<{ name: string; browser_download_url: string }> },
  platform: Platform,
): string | null {
  if (platform.os === "mac") {
    const arch = detectMacArch();
    const suffix = arch === "arm64" ? "arm64.dmg" : "x64.dmg";
    const match = release.assets.find((asset) => asset.name.endsWith(`-${suffix}`));
    return match?.browser_download_url ?? null;
  }

  if (platform.os === "win") {
    const match = release.assets.find((asset) => asset.name.endsWith("-x64.exe"));
    return match?.browser_download_url ?? null;
  }

  if (platform.os === "linux") {
    const match = release.assets.find((asset) => asset.name.endsWith(".AppImage"));
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
    const assetUrl = pickAssetUrl(release, platform);

    if (assetUrl) {
      btn.href = assetUrl;
      // Open downloads in a new tab to avoid navigating away from the marketing site
      btn.target = "_blank";
      btn.rel = "noopener noreferrer";
    } else {
      // Fallback to the download page if no matching asset is found
      btn.href = "/download";
    }
  } catch {
    // Keep the default /download link if fetching the release fails
    btn.href = "/download";
  }
}
