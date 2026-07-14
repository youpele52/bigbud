import { DOWNLOAD_BUTTON_LABELS, RELEASE_ASSET_SUFFIXES } from "../../../constants/downloads";
import { fetchLatestRelease } from "../../../lib/releases";

const HOME_INTRO_DESKTOP = {
  canvasWidth: 640,
  durationMs: 1450,
  revealMs: 950,
} as const;

const HOME_INTRO_MOBILE = {
  canvasWidth: 280,
  durationMs: 1300,
  revealMs: 800,
} as const;

type Platform = { os: "mac" | "win" | "linux" };

type SignalTear = {
  angle: number;
  alpha: number;
  height: number;
  width: number;
  x: number;
  y: number;
};

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function createSignalTears(width: number, height: number): SignalTear[] {
  const count = 2 + Math.floor(Math.random() * 4);

  return Array.from({ length: count }, () => {
    const tearWidth = width * 1.16;

    return {
      alpha: randomBetween(0.28, 0.52),
      angle: randomBetween(-0.075, 0.075),
      height: randomBetween(0.45, 0.85),
      width: tearWidth,
      x: -width * 0.08,
      y: height * randomBetween(0.14, 0.86),
    };
  }).toSorted((first, second) => first.y - second.y);
}

function drawSignalTears(context: CanvasRenderingContext2D, tears: SignalTear[]): void {
  for (const tear of tears) {
    context.save();
    context.translate(tear.x + tear.width / 2, tear.y);
    context.rotate(tear.angle);
    context.fillStyle = `rgb(255 255 255 / ${tear.alpha})`;
    context.fillRect(-tear.width / 2, -tear.height / 2, tear.width, tear.height);
    context.fillStyle = `rgb(0 0 0 / ${tear.alpha})`;
    context.fillRect(-tear.width / 2, tear.height / 2, tear.width, tear.height);
    context.restore();
  }
}

function releaseHomeIntro(): void {
  const root = document.documentElement;
  if (root.dataset.homeIntro !== "playing") return;

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    root.dataset.homeIntro = "complete";
    return;
  }

  const startedAt = Number(root.dataset.homeIntroStart ?? "0");
  const elapsed = Math.max(0, performance.now() - startedAt);
  const canvas = document.getElementById("home-intro");
  if (!(canvas instanceof HTMLCanvasElement)) {
    root.dataset.homeIntro = "complete";
    return;
  }

  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) {
    root.dataset.homeIntro = "complete";
    return;
  }

  const staticContext: CanvasRenderingContext2D = context;
  const isMobile = window.matchMedia("(max-width: 640px)").matches;
  const profile = isMobile ? HOME_INTRO_MOBILE : HOME_INTRO_DESKTOP;
  const width = profile.canvasWidth;
  const height = Math.max(1, Math.round(width * (window.innerHeight / window.innerWidth)));
  const frame = staticContext.createImageData(width, height);
  const pixels = frame.data;
  const signalTears = createSignalTears(width, height);
  let frameHandle = 0;
  let lastFrameAt = 0;

  canvas.width = width;
  canvas.height = height;

  function drawStatic(timestamp: number): void {
    if (timestamp - lastFrameAt >= 45) {
      lastFrameAt = timestamp;

      for (let index = 0; index < pixels.length; index += 4) {
        const value = Math.random() * 255;
        pixels[index] = value;
        pixels[index + 1] = value;
        pixels[index + 2] = value;
        pixels[index + 3] = 255;
      }

      staticContext.putImageData(frame, 0, 0);

      if (timestamp - startedAt > profile.revealMs * 0.65) {
        drawSignalTears(staticContext, signalTears);
      }
    }

    frameHandle = window.requestAnimationFrame(drawStatic);
  }

  const revealIn = Math.max(0, profile.revealMs - elapsed);
  const finishIn = Math.max(0, profile.durationMs - elapsed);

  frameHandle = window.requestAnimationFrame(drawStatic);

  window.setTimeout(() => {
    if (root.dataset.homeIntro === "playing") {
      root.dataset.homeIntro = "revealing";
    }
  }, revealIn);

  window.setTimeout(() => {
    if (root.dataset.homeIntro !== "complete") {
      root.dataset.homeIntro = "complete";
    }
    window.cancelAnimationFrame(frameHandle);
  }, finishIn);
}

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
  releaseHomeIntro();

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
