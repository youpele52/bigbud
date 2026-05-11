import { DOWNLOAD_BUTTON_LABELS } from "../../../constants/downloads";

type Platform = { os: "mac" | "win" | "linux" };

function detectPlatform(): Platform | null {
  const ua = navigator.userAgent;
  if (/Win/i.test(ua)) return { os: "win" };
  if (/Mac/i.test(ua)) return { os: "mac" };
  if (/Linux/i.test(ua)) return { os: "linux" };
  return null;
}

export function initHomeHero(): void {
  const btn = document.getElementById("download-btn") as HTMLAnchorElement | null;
  if (!btn) return;

  const platform = detectPlatform();
  if (!platform) return;

  document.documentElement.dataset.platform = platform.os;
  btn.setAttribute("aria-label", DOWNLOAD_BUTTON_LABELS[platform.os]);
}
