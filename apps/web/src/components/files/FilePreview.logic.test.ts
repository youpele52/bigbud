import { describe, expect, it } from "vitest";

import { clampPreviewTargetLine, getPreviewScrollTop } from "./FilePreview.logic";

describe("clampPreviewTargetLine", () => {
  it("returns null when no target line is provided", () => {
    expect(clampPreviewTargetLine(undefined, 10)).toBeNull();
  });

  it("clamps the target line into the available line range", () => {
    expect(clampPreviewTargetLine(0, 10)).toBeNull();
    expect(clampPreviewTargetLine(3, 10)).toBe(3);
    expect(clampPreviewTargetLine(99, 10)).toBe(10);
  });
});

describe("getPreviewScrollTop", () => {
  it("returns null when there is no valid target line", () => {
    expect(getPreviewScrollTop(undefined, 12, 200)).toBeNull();
  });

  it("centers the requested line in the preview viewport", () => {
    expect(getPreviewScrollTop(8, 20, 200)).toBe(60);
  });

  it("clamps negative scroll offsets to zero", () => {
    expect(getPreviewScrollTop(1, 20, 200)).toBe(0);
  });

  it("uses the last available line when the request exceeds file length", () => {
    expect(getPreviewScrollTop(50, 12, 200)).toBe(140);
  });
});
