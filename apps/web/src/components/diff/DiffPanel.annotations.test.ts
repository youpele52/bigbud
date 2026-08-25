import { describe, expect, it } from "vitest";

import { resolveDiffAnnotationLeft, resolveDiffAnnotationWidth } from "./DiffPanel.annotations";

describe("resolveDiffAnnotationLeft", () => {
  it("centers a full-width annotation panel", () => {
    expect(resolveDiffAnnotationLeft(1000)).toBe(290);
  });

  it("retains the viewport margin when space is constrained", () => {
    expect(resolveDiffAnnotationLeft(320)).toBe(16);
    expect(resolveDiffAnnotationWidth(320)).toBe(288);
  });
});
