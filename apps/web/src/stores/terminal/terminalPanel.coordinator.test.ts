import { afterEach, describe, expect, it } from "vitest";

import { closeTerminalPanel, toggleTerminalPanel } from "./terminalPanel.coordinator";
import { useTerminalPanelStore } from "./terminalPanel.store";
import { getRequestedRightPanel, requestRightPanel } from "../rightPanel/rightPanel.coordinator";
import { useRightPanelTabsStore } from "../rightPanel/rightPanelTabs.store";

describe("terminalPanel.coordinator", () => {
  afterEach(() => {
    useTerminalPanelStore.setState({ open: false });
    useRightPanelTabsStore.setState({ activeKind: null, openTabs: [], rightPanelOpen: false });
    requestRightPanel(null);
  });

  it("activates terminal instead of closing it when its tab is already open in the background", () => {
    useTerminalPanelStore.setState({ open: true });
    useRightPanelTabsStore.setState({
      activeKind: "browser",
      openTabs: ["terminal", "browser"],
      rightPanelOpen: true,
    });

    toggleTerminalPanel();

    expect(useTerminalPanelStore.getState().open).toBe(true);
    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "terminal",
      openTabs: ["terminal", "browser"],
      rightPanelOpen: true,
    });
  });

  it("closes terminal only when toggling the active terminal tab", () => {
    useTerminalPanelStore.setState({ open: true });
    requestRightPanel("terminal");
    useRightPanelTabsStore.setState({
      activeKind: "terminal",
      openTabs: ["terminal"],
      rightPanelOpen: true,
    });

    toggleTerminalPanel();

    expect(useTerminalPanelStore.getState().open).toBe(false);
    expect(getRequestedRightPanel()).toBeNull();
  });

  it("closeTerminalPanel preserves the neighboring active tab", () => {
    useTerminalPanelStore.setState({ open: true });
    requestRightPanel("terminal");
    useRightPanelTabsStore.setState({
      activeKind: "terminal",
      openTabs: ["browser", "terminal", "files"],
      rightPanelOpen: true,
    });

    closeTerminalPanel();

    expect(useRightPanelTabsStore.getState()).toMatchObject({
      activeKind: "browser",
      openTabs: ["browser", "files"],
      rightPanelOpen: true,
    });
  });
});
