import { describe, expect, it } from "vitest";

import { clampFilesTreeWidth, getFilesTreeWidthBounds } from "./FilesPanel.treeWidth.logic";

describe("files split width bounds", () => {
  it.each([
    [900, 220, 445],
    [700, 220, 245],
    [500, 220, 220],
    [180, 108, 108],
    [0, 0, 0],
  ])("shares responsive bounds at panel width %s", (width, min, max) => {
    expect(getFilesTreeWidthBounds(width)).toEqual({ min, max });
    expect(clampFilesTreeWidth(1000, width)).toBe(max);
    expect(clampFilesTreeWidth(0, width)).toBe(min);
  });

  it("starts resizing from the capped width without an invisible saved-width gap", () => {
    const rendered = clampFilesTreeWidth(500, 900);
    expect(rendered).toBe(445);
    expect(clampFilesTreeWidth(rendered - 20, 900)).toBe(425);
    expect(clampFilesTreeWidth(425 + 100, 900)).toBe(445);
  });
});
