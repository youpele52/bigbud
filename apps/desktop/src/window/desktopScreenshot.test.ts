import { describe, expect, it, beforeEach, vi } from "vitest";
import type { Display } from "electron";

const mocks = vi.hoisted(() => ({
  getSources: vi.fn(),
  getMediaAccessStatus: vi.fn(),
}));
vi.mock("electron", () => ({
  desktopCapturer: { getSources: mocks.getSources },
  systemPreferences: { getMediaAccessStatus: mocks.getMediaAccessStatus },
}));

import { captureDesktopScreenshot, DESKTOP_SCREENSHOT_TIMEOUT_MS } from "./desktopScreenshot";

const display = { id: 42, size: { width: 1920, height: 1080 }, scaleFactor: 2 } as Display;
function source(displayId = "42", bytes = Buffer.from("jpeg")) {
  return {
    display_id: displayId,
    thumbnail: {
      isEmpty: () => false,
      getSize: () => ({ width: 2560, height: 1440 }),
      toJPEG: vi.fn(() => bytes),
      resize: vi.fn(),
    },
  };
}

describe("desktop screenshots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMediaAccessStatus.mockReturnValue("granted");
    mocks.getSources.mockResolvedValue([source()]);
  });

  it("checks only macOS screen permission and captures without Accessibility or CUA", async () => {
    const result = await captureDesktopScreenshot(display, "darwin");
    expect(mocks.getMediaAccessStatus).toHaveBeenCalledExactlyOnceWith("screen");
    expect(mocks.getSources).toHaveBeenCalledExactlyOnceWith({
      types: ["screen"],
      thumbnailSize: { width: 2560, height: 1440 },
      fetchWindowIcons: false,
    });
    expect(result).toEqual({
      mimeType: "image/jpeg",
      sizeBytes: 4,
      dataUrl: "data:image/jpeg;base64,anBlZw==",
    });
  });

  it.each(["denied", "restricted", "not-determined", "unknown"])(
    "guides macOS %s permission to existing settings without capturing",
    async (status) => {
      mocks.getMediaAccessStatus.mockReturnValue(status);
      await expect(captureDesktopScreenshot(display, "darwin")).rejects.toThrow(
        "Allow Screen Recording",
      );
      expect(mocks.getSources).not.toHaveBeenCalled();
    },
  );

  it.each(["win32", "linux"] as const)(
    "does not invoke macOS permission APIs on %s",
    async (platform) => {
      await captureDesktopScreenshot(display, platform);
      expect(mocks.getMediaAccessStatus).not.toHaveBeenCalled();
    },
  );

  it("selects the mascot's monitor even when it is not the first source", async () => {
    const chosen = source();
    const primary = source("1");
    mocks.getSources.mockResolvedValue([primary, chosen]);
    await captureDesktopScreenshot(display, "win32");
    expect(chosen.thumbnail.toJPEG).toHaveBeenCalled();
    expect(primary.thumbnail.toJPEG).not.toHaveBeenCalled();
  });

  it("accepts the single system-selected PipeWire source without a display ID", async () => {
    mocks.getSources.mockResolvedValue([source("")]);
    await expect(captureDesktopScreenshot(display, "linux")).resolves.toMatchObject({
      sizeBytes: 4,
    });
  });

  it.each([{ sources: [] }, { sources: [source("1")] }, { sources: [source(""), source("")] }])(
    "rejects unavailable or ambiguous displays",
    async ({ sources }) => {
      mocks.getSources.mockResolvedValue(sources);
      await expect(captureDesktopScreenshot(display, "linux")).rejects.toThrow(
        "No screenshot was captured",
      );
    },
  );

  it("rejects empty capture after cancellation", async () => {
    const empty = source();
    empty.thumbnail.isEmpty = () => true;
    mocks.getSources.mockResolvedValue([empty]);
    await expect(captureDesktopScreenshot(display, "linux")).rejects.toThrow(
      "No screenshot was captured",
    );
  });

  it("bounds unexpected native image dimensions before encoding", async () => {
    const large = source();
    large.thumbnail.getSize = () => ({ width: 4000, height: 6000 });
    large.thumbnail.resize.mockReturnValue(source().thumbnail);
    mocks.getSources.mockResolvedValue([large]);
    await captureDesktopScreenshot(display, "win32");
    expect(large.thumbnail.resize).toHaveBeenCalledWith({ height: 2560, quality: "best" });
  });

  it("rejects images larger than the shared attachment limit", async () => {
    mocks.getSources.mockResolvedValue([source("42", Buffer.alloc(10 * 1024 * 1024 + 1))]);
    await expect(captureDesktopScreenshot(display, "win32")).rejects.toThrow("attachment limit");
  });

  it("propagates capture failures for the action's recovery UI", async () => {
    mocks.getSources.mockRejectedValue(new Error("screen source unavailable"));
    await expect(captureDesktopScreenshot(display, "linux")).rejects.toThrow(
      "screen source unavailable",
    );
  });

  it("times out without allowing overlapping native requests, then recovers when the OS finishes", async () => {
    vi.useFakeTimers();
    let finish!: (sources: ReturnType<typeof source>[]) => void;
    mocks.getSources.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    try {
      const request = captureDesktopScreenshot(display, "linux");
      const failed = expect(request).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(DESKTOP_SCREENSHOT_TIMEOUT_MS);
      await failed;
      await expect(captureDesktopScreenshot(display, "linux")).rejects.toThrow("previous capture");
      expect(mocks.getSources).toHaveBeenCalledOnce();
      finish([source()]);
      await vi.advanceTimersByTimeAsync(1);
      await expect(captureDesktopScreenshot(display, "linux")).resolves.toMatchObject({
        sizeBytes: 4,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
