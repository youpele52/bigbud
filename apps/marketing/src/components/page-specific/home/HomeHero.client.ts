import { DEFAULT_MAC_ARCH, DOWNLOAD_BUTTON_LABELS } from "../../../constants/downloads";
import { fetchLatestRelease, RELEASES_URL, type ReleaseAsset } from "../../../lib/releases";

type Platform = { os: "mac" | "win" | "linux"; arch?: string };

function detectPlatform(): Platform | null {
  const ua = navigator.userAgent;
  if (/Win/i.test(ua)) return { os: "win" };
  if (/Mac/i.test(ua)) {
    return {
      os: "mac",
      arch: DEFAULT_MAC_ARCH,
    };
  }
  if (/Linux/i.test(ua)) return { os: "linux" };
  return null;
}

function pickAsset(assets: ReleaseAsset[], platform: Platform): string | null {
  if (platform.os === "win") {
    return assets.find((asset) => asset.name.endsWith("-x64.exe"))?.browser_download_url ?? null;
  }

  if (platform.os === "mac") {
    const preferred = assets.find((asset) => asset.name.endsWith(`-${platform.arch}.dmg`));
    const fallback = assets.find((asset) => asset.name.endsWith(".dmg"));
    return (preferred ?? fallback)?.browser_download_url ?? null;
  }

  if (platform.os === "linux") {
    return assets.find((asset) => asset.name.endsWith(".AppImage"))?.browser_download_url ?? null;
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
    const url = pickAsset(release.assets ?? [], platform);
    if (url) {
      btn.href = url;
      btn.removeAttribute("target");
      btn.removeAttribute("rel");
    }
  } catch {
    btn.href = RELEASES_URL;
  }
}
