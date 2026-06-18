import { describe, expect, it } from "vitest";

import {
  computeBrowserAnnotationCropBounds,
  shouldCropBrowserAnnotationImage,
} from "./BrowserPanel.annotation.image";

describe("browser annotation image helpers", () => {
  it("only crops PDF region annotations", () => {
    expect(
      shouldCropBrowserAnnotationImage({
        selector: "",
        tag: "pdf-region",
        role: "region",
        text: "",
        ariaLabel: null,
        id: null,
        className: "",
        rect: { x: 1, y: 2, width: 3, height: 4 },
      }),
    ).toBe(true);

    expect(
      shouldCropBrowserAnnotationImage({
        selector: "#save",
        tag: "button",
        role: "button",
        text: "Save",
        ariaLabel: null,
        id: "save",
        className: "",
        rect: { x: 1, y: 2, width: 3, height: 4 },
      }),
    ).toBe(false);
  });

  it("computes a tightly padded crop for a selected PDF region", () => {
    expect(
      computeBrowserAnnotationCropBounds({
        element: {
          selector: "",
          tag: "pdf-region",
          role: "region",
          text: "",
          ariaLabel: null,
          id: null,
          className: "",
          rect: { x: 40, y: 50, width: 140, height: 160 },
        },
        viewport: { width: 640, height: 480, devicePixelRatio: 2 },
        imageWidth: 1280,
        imageHeight: 960,
      }),
    ).toEqual({
      left: 72,
      top: 92,
      width: 296,
      height: 336,
    });
  });
});
