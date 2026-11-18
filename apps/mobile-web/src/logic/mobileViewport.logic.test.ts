import { describe, expect, it } from "vitest";

import { resolveMobileViewport } from "./mobileViewport.logic";

describe("mobile visible viewport geometry", () => {
  it("keeps the shell above a keyboard without requiring a layout viewport resize", () => {
    expect(resolveMobileViewport({ height: 460, offsetTop: 32, scale: 1 }, 844)).toEqual({
      height: 460,
      top: 32,
    });
  });

  it("does not reflow the shell in response to pinch zoom", () => {
    expect(resolveMobileViewport({ height: 230, offsetTop: 100, scale: 2 }, 844)).toBeNull();
    expect(resolveMobileViewport({ height: 844, offsetTop: 0, scale: 0.8 }, 844)).toBeNull();
  });

  it("bounds transient browser-chrome overscroll and stale orientation measurements", () => {
    expect(resolveMobileViewport({ height: 460, offsetTop: -12, scale: 1 }, 844)).toEqual({
      height: 460,
      top: 0,
    });
    expect(resolveMobileViewport({ height: 460, offsetTop: 600, scale: 1 }, 844)).toEqual({
      height: 460,
      top: 384,
    });
    expect(resolveMobileViewport({ height: 844, offsetTop: 32, scale: 1 }, 390)).toEqual({
      height: 390,
      top: 0,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores an unusable viewport or layout height %s",
    (height) => {
      expect(resolveMobileViewport({ height, offsetTop: 0, scale: 1 }, 844)).toBeNull();
      expect(resolveMobileViewport({ height: 460, offsetTop: 0, scale: 1 }, height)).toBeNull();
    },
  );

  it("ignores invalid pan and zoom measurements", () => {
    expect(resolveMobileViewport({ height: 460, offsetTop: Number.NaN, scale: 1 }, 844)).toBeNull();
    expect(resolveMobileViewport({ height: 460, offsetTop: 0, scale: Number.NaN }, 844)).toBeNull();
  });
});
