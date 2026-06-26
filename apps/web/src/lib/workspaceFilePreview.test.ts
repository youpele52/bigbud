import { describe, expect, it } from "vitest";

import { isHtmlFilePath, isImageFilePath } from "./workspaceFilePreview";

describe("isImageFilePath", () => {
  it("recognizes common raster and vector image extensions", () => {
    expect(isImageFilePath("assets/logo.png")).toBe(true);
    expect(isImageFilePath("assets/photo.JPG")).toBe(true);
    expect(isImageFilePath("assets/icon.webp")).toBe(true);
    expect(isImageFilePath("assets/diagram.svg")).toBe(true);
  });

  it("ignores non-image files", () => {
    expect(isImageFilePath("README.md")).toBe(false);
    expect(isImageFilePath("docs/report.pdf")).toBe(false);
    expect(isImageFilePath("src/index.ts")).toBe(false);
  });

  it("strips line suffixes before checking the extension", () => {
    expect(isImageFilePath("/tmp/workspace/assets/logo.png:12")).toBe(true);
  });
});

describe("isHtmlFilePath", () => {
  it("recognizes html and htm extensions", () => {
    expect(isHtmlFilePath("public/index.html")).toBe(true);
    expect(isHtmlFilePath("public/legacy.HTM")).toBe(true);
  });

  it("ignores non-html files", () => {
    expect(isHtmlFilePath("README.md")).toBe(false);
    expect(isHtmlFilePath("assets/logo.png")).toBe(false);
    expect(isHtmlFilePath("docs/report.pdf")).toBe(false);
  });

  it("strips line suffixes before checking the extension", () => {
    expect(isHtmlFilePath("/tmp/workspace/public/index.html:12")).toBe(true);
  });
});
