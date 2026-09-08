import { describe, expect, it } from "vitest";

import { getMediaPreviewPhase } from "./mediaPreviewState";

describe("getMediaPreviewPhase", () => {
  it("stays loading until the current URL loads", () => {
    expect(
      getMediaPreviewPhase({
        url: "/preview/image.png?v=0",
        loadedUrl: null,
        errorUrl: null,
      }),
    ).toBe("loading");
    expect(
      getMediaPreviewPhase({
        url: "/preview/image.png?v=0",
        loadedUrl: "/preview/image.png?v=0",
        errorUrl: null,
      }),
    ).toBe("loaded");
  });

  it("returns to loading when the URL or refresh version changes", () => {
    expect(
      getMediaPreviewPhase({
        url: "/preview/other.png?v=1",
        loadedUrl: "/preview/image.png?v=0",
        errorUrl: "/preview/image.png?v=0",
      }),
    ).toBe("loading");
  });

  it("shows an error only for the current URL", () => {
    expect(
      getMediaPreviewPhase({
        url: "/preview/video.mp4?v=0",
        loadedUrl: null,
        errorUrl: "/preview/video.mp4?v=0",
      }),
    ).toBe("error");
  });
});
