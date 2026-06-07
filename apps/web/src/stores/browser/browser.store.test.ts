import { beforeEach, describe, expect, it } from "vitest";

import { useBrowserPanelStore } from "./browser.store";

describe("browser.store", () => {
  beforeEach(() => {
    useBrowserPanelStore.setState({ open: false, tabsById: {} });
  });

  it("does not replace state when ensuring an existing tab", () => {
    useBrowserPanelStore.getState().ensureTab("browser:1", "https://example.com");

    const stateBefore = useBrowserPanelStore.getState();
    const tabsBefore = stateBefore.tabsById;

    useBrowserPanelStore.getState().ensureTab("browser:1", "https://example.com");

    const stateAfter = useBrowserPanelStore.getState();
    expect(stateAfter).toBe(stateBefore);
    expect(stateAfter.tabsById).toBe(tabsBefore);
  });

  it("does not replace state when setting the same title or url", () => {
    useBrowserPanelStore.getState().ensureTab("browser:1", "https://example.com");
    useBrowserPanelStore.getState().setTabTitle("browser:1", "Example");

    const stateBeforeTitle = useBrowserPanelStore.getState();
    useBrowserPanelStore.getState().setTabTitle("browser:1", "Example");
    expect(useBrowserPanelStore.getState()).toBe(stateBeforeTitle);

    const stateBeforeUrl = useBrowserPanelStore.getState();
    useBrowserPanelStore.getState().setTabUrl("browser:1", "https://example.com");
    expect(useBrowserPanelStore.getState()).toBe(stateBeforeUrl);
  });
});
