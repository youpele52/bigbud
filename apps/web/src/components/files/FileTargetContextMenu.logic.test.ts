import { describe, expect, it } from "vitest";

import { buildFileTargetMenuGroups } from "./FileTargetContextMenu.logic";

const all = {
  canOpenInBrowser: false,
  canOpenInFileViewer: false,
  canOpenDirectoryInternally: true,
  canOpenExternally: true,
  canCopyRelativePath: true,
  canCopyPath: true,
  canUsePathCheckpoints: true,
};

const labels = (groups: ReturnType<typeof buildFileTargetMenuGroups>) =>
  groups.map((group) => group.map((item) => item.label));

describe("file target context menu groups", () => {
  it("groups open | copy | capture | destructive with Delete right before Restore", () => {
    const groups = buildFileTargetMenuGroups({ ...all, deleteDisabledReason: null });
    expect(labels(groups)).toEqual([
      ["Open internally", "Open externally"],
      ["Copy relative path", "Copy path"],
      ["Capture path checkpoint"],
      ["Delete…", "Restore path checkpoint"],
    ]);
    const destructive = groups[3]!;
    expect(destructive.every((item) => item.destructive)).toBe(true);
    expect(destructive[0]!.disabledReason).toBeUndefined();
  });

  it("hides Delete where it is not offered and disables it with a reason when read only", () => {
    expect(labels(buildFileTargetMenuGroups(all)).flat()).not.toContain("Delete…");
    const readOnly = buildFileTargetMenuGroups({
      ...all,
      canUsePathCheckpoints: false,
      deleteDisabledReason: "Direct SSH files can't be edited yet.",
    });
    expect(labels(readOnly)).toEqual([
      ["Open internally", "Open externally"],
      ["Copy relative path", "Copy path"],
      ["Delete…"],
    ]);
    expect(readOnly[2]![0]!.disabledReason).toBe("Direct SSH files can't be edited yet.");
  });
});
