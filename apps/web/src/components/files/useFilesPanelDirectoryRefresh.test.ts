import { describe, expect, it } from "vitest";

import type { DirectoryState } from "./FilesPanel.shared";
import { getVisibleDirectoryPaths } from "./useFilesPanelDirectoryRefresh";

function makeDirectoryState(): DirectoryState {
  return {
    entries: [],
    loading: false,
    error: null,
  };
}

describe("getVisibleDirectoryPaths", () => {
  it("includes the root and loaded expanded directories", () => {
    expect(
      getVisibleDirectoryPaths(
        {
          docs: true,
          "docs/plan": true,
          scripts: false,
          missing: true,
        },
        {
          "": makeDirectoryState(),
          docs: makeDirectoryState(),
          "docs/plan": makeDirectoryState(),
          scripts: makeDirectoryState(),
        },
      ),
    ).toEqual(["", "docs", "docs/plan"]);
  });
});
