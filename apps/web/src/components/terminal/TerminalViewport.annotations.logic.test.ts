import { describe, expect, it } from "vitest";

import { resolveTerminalAnnotationOverlayPosition } from "./TerminalViewport.annotations.logic";

describe("resolveTerminalAnnotationOverlayPosition", () => {
  it("clamps overlay coordinates inside the viewport", () => {
    expect(
      resolveTerminalAnnotationOverlayPosition({
        anchorX: 260,
        anchorY: 144,
        viewportWidth: 1024,
        viewportHeight: 768,
      }),
    ).toEqual({
      left: 260,
      top: 144,
    });
  });

  it("keeps the panel on-screen when the anchor is near the right edge", () => {
    expect(
      resolveTerminalAnnotationOverlayPosition({
        anchorX: 980,
        anchorY: 120,
        viewportWidth: 1024,
        viewportHeight: 768,
      }),
    ).toEqual({
      left: 588,
      top: 120,
    });
  });

  it("keeps the panel on-screen when the anchor is near the bottom edge", () => {
    expect(
      resolveTerminalAnnotationOverlayPosition({
        anchorX: 120,
        anchorY: 760,
        viewportWidth: 1024,
        viewportHeight: 768,
      }),
    ).toEqual({
      left: 120,
      top: 488,
    });
  });

  it("never positions the panel above the minimum edge padding", () => {
    expect(
      resolveTerminalAnnotationOverlayPosition({
        anchorX: 4,
        anchorY: 2,
        viewportWidth: 1024,
        viewportHeight: 768,
      }),
    ).toEqual({
      left: 16,
      top: 16,
    });
  });
});
