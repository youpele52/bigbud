import { describe, expect, it } from "vitest";

import {
  buildGitChangedFileMenuItems,
  describeGitDiscardConfirmation,
} from "./GitPanel.discard.logic";

describe("GitPanel.discard.logic", () => {
  it("puts copy actions first, then a divider, then discard actions without a trash icon", () => {
    const items = buildGitChangedFileMenuItems({ selectedText: "abc" });
    expect(items.map((item) => item.id)).toEqual([
      "copy-selected-text",
      "copy-path",
      "copy-filename",
      "separator-discard",
      "discard-file",
      "discard-all",
    ]);
    expect(items.some((item) => item.destructive)).toBe(false);
    expect(items[3]?.separator).toBe(true);
  });

  it("describes a single-file discard as irreversible, with Trash wording locally", () => {
    const copy = describeGitDiscardConfirmation(
      { scope: "paths", paths: ["src/a.ts"] },
      { isRemote: false },
    );
    expect(copy.title).toBe("Discard changes to src/a.ts?");
    expect(copy.description).toContain("cannot be undone");
    expect(copy.description).toContain("moved to the Trash");
    expect(copy.confirmLabel).toBe("Discard changes");
  });

  it("describes discard all with the file count and remote deletion", () => {
    const copy = describeGitDiscardConfirmation(
      { scope: "all", paths: ["a", "b", "c"] },
      { isRemote: true },
    );
    expect(copy.title).toBe("Discard all changes to 3 files?");
    expect(copy.description).toContain("untracked files are deleted");
    expect(copy.description).toContain("cannot be undone");
    expect(copy.confirmLabel).toBe("Discard all changes");
  });
});
