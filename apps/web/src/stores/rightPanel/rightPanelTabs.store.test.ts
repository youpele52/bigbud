import { afterEach, describe, expect, it } from "vitest";

import { useRightPanelTabsStore } from "./rightPanelTabs.store";

describe("rightPanelTabs.store", () => {
  afterEach(() => {
    useRightPanelTabsStore.setState({
      activeKind: null,
      lastActiveKind: null,
      openTabs: [],
      rightPanelOpen: false,
    });
  });

  it("keeps the current tab active when ensuring another tab stays open", () => {
    useRightPanelTabsStore.setState({
      activeKind: "browser",
      lastActiveKind: "browser",
      openTabs: ["browser"],
      rightPanelOpen: true,
    });

    useRightPanelTabsStore.getState().ensureTabOpen("diff");

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "browser",
      lastActiveKind: "browser",
      openTabs: ["browser", "diff"],
      rightPanelOpen: true,
    });
  });
});
