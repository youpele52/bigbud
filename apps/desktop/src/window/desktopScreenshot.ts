import {
  desktopCapturer,
  systemPreferences,
  type DesktopCapturerSource,
  type Display,
  type SourcesOptions,
} from "electron";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@bigbud/contracts/orchestration/orchestration.provider";

const MAX_SCREENSHOT_DIMENSION = 2560;
export const DESKTOP_SCREENSHOT_TIMEOUT_MS = 30_000;
let sourceRequestInFlight = false;

async function getScreenshotSources(options: SourcesOptions): Promise<DesktopCapturerSource[]> {
  if (sourceRequestInFlight) {
    throw new Error(
      "The previous capture is still waiting for the system. Finish or cancel its screen selection, then retry.",
    );
  }
  sourceRequestInFlight = true;
  const request = Promise.resolve().then(() => desktopCapturer.getSources(options));
  void request.then(
    () => {
      sourceRequestInFlight = false;
    },
    () => {
      sourceRequestInFlight = false;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "Screen capture timed out. Finish or cancel the system's screen selection, then try again.",
              ),
            ),
          DESKTOP_SCREENSHOT_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class ScreenRecordingPermissionError extends Error {
  constructor() {
    super("Allow Screen Recording for bigbud in System Settings, then try again.");
  }
}

export function requireScreenRecordingPermission(platform: NodeJS.Platform): void {
  if (platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    throw new ScreenRecordingPermissionError();
  }
}

/** Captures only pixels; does not depend on Accessibility or the Computer Use runtime. */
export async function captureDesktopScreenshot(display: Display, platform = process.platform) {
  requireScreenRecordingPermission(platform);
  const width = Math.round(display.size.width * display.scaleFactor);
  const height = Math.round(display.size.height * display.scaleFactor);
  const scale = Math.min(1, MAX_SCREENSHOT_DIMENSION / Math.max(width, height));
  const sources = await getScreenshotSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    },
    fetchWindowIcons: false,
  });
  // PipeWire can return one system-selected source without a display ID. Never
  // guess between multiple unmatched displays or substitute the primary monitor.
  const source =
    sources.find((candidate) => candidate.display_id === String(display.id)) ??
    (sources.length === 1 && sources[0]?.display_id === "" ? sources[0] : undefined);
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error("No screenshot was captured. Check screen access and try again.");
  }
  let image = source.thumbnail;
  const size = image.getSize();
  if (Math.max(size.width, size.height) > MAX_SCREENSHOT_DIMENSION) {
    image = image.resize(
      size.width >= size.height
        ? { width: MAX_SCREENSHOT_DIMENSION, quality: "best" }
        : { height: MAX_SCREENSHOT_DIMENSION, quality: "best" },
    );
  }
  const bytes = image.toJPEG(85);
  if (bytes.length === 0 || bytes.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    throw new Error("The screenshot exceeds the image attachment limit. Try a smaller display.");
  }
  return {
    mimeType: "image/jpeg" as const,
    sizeBytes: bytes.length,
    dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
  };
}
