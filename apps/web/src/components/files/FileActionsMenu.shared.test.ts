import { describe, expect, it } from "vitest";

import { createSharedFileActionItems } from "./FileActionsMenu.shared";

describe("FileActionsMenu.shared", () => {
  it("orders the shared file actions consistently", () => {
    expect(
      createSharedFileActionItems({
        canSelectAll: true,
        canOpenExternally: true,
        canCopyRelativePath: true,
        canCopyPath: true,
      }),
    ).toEqual([
      { id: "select-all", label: "Select All" },
      { id: "open-externally", label: "Open externally" },
      { id: "copy-relative-path", label: "Copy relative path" },
      { id: "copy-path", label: "Copy path" },
    ]);
  });

  it("omits unavailable actions without changing the remaining order", () => {
    expect(
      createSharedFileActionItems({
        canSelectAll: false,
        canOpenExternally: true,
        canCopyRelativePath: false,
        canCopyPath: true,
      }),
    ).toEqual([
      { id: "open-externally", label: "Open externally" },
      { id: "copy-path", label: "Copy path" },
    ]);
  });
});
