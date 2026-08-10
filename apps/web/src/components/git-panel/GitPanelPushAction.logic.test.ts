import { describe, expect, it } from "vitest";

import { getGitPanelPushLabel } from "./GitPanelPushAction.logic";

describe("getGitPanelPushLabel", () => {
  it("uses the singular label for one unpushed commit", () => {
    expect(getGitPanelPushLabel(1)).toBe("Push commit");
  });

  it("includes the ahead count for multiple unpushed commits", () => {
    expect(getGitPanelPushLabel(8)).toBe("Push 8 commits");
  });
});
