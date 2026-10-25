import "../../index.css";

import { Folder02Icon } from "@hugeicons/core-free-icons";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { useRightPanelTabsStore } from "~/stores/rightPanel/rightPanelTabs.store";
import { RightPanelTabs } from "./RightPanelTabs";

function expectFilesIcon(element: Element) {
  const icon = element.querySelector<SVGSVGElement>("svg")!;
  expect(icon).not.toBeNull();
  expect(icon.getAttribute("aria-hidden")).toBe("true");
  expect(icon.classList).toContain("size-3.5");
  expect(getComputedStyle(icon).width).toBe("14px");
  expect(Array.from(icon.querySelectorAll("path"), (path) => path.getAttribute("d"))).toEqual(
    Folder02Icon.map(([, attributes]) => attributes.d),
  );
}

describe("Right panel navigation", () => {
  beforeEach(() => {
    useRightPanelTabsStore.setState({
      activeKind: "files",
      activeTabId: "files",
      openTabs: ["files"],
      rightPanelOpen: true,
      lastActiveKind: "files",
    });
  });
  afterEach(() => {
    useRightPanelTabsStore.setState(useRightPanelTabsStore.getInitialState(), true);
  });

  it("shares Folder02 artwork between the Files tab and + menu without changing the open action", async () => {
    const onSelect = vi.fn();
    const onOpenFiles = vi.fn();
    const mounted = await render(
      <RightPanelTabs
        browserShortcutLabel={null}
        filesShortcutLabel={null}
        hasActiveProject
        onCloseBrowserTab={onSelect}
        onCloseFiles={onSelect}
        onCloseSystem={onSelect}
        onCloseUsage={onSelect}
        onCloseTerminal={onSelect}
        onOpenNewBrowserTab={onSelect}
        onOpenFiles={onOpenFiles}
        onOpenSystem={onSelect}
        onOpenUsage={onSelect}
        onOpenTerminal={onSelect}
        terminalAvailable
        terminalShortcutLabel={null}
      />,
    );
    try {
      expectFilesIcon(page.getByRole("button", { name: "Files", exact: true }).element());
      await page.getByRole("button", { name: "Open another right panel tab" }).click();
      const filesMenuItem = page.getByRole("menuitem", { name: "Files", exact: true });
      await expect.element(filesMenuItem).toBeVisible();
      expectFilesIcon(filesMenuItem.element());
      await filesMenuItem.click();
      expect(onOpenFiles).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
    }
  });

  it("opens, selects, and closes Usage through the existing tab menu", async () => {
    useRightPanelTabsStore.setState({ openTabs: ["files", "system"] });
    const onSelect = vi.fn();
    const mounted = await render(
      <RightPanelTabs
        browserShortcutLabel={null}
        filesShortcutLabel={null}
        hasActiveProject
        onCloseBrowserTab={onSelect}
        onCloseFiles={onSelect}
        onCloseSystem={onSelect}
        onCloseUsage={() => useRightPanelTabsStore.getState().closeTab("usage")}
        onCloseTerminal={onSelect}
        onOpenNewBrowserTab={onSelect}
        onOpenFiles={onSelect}
        onOpenSystem={onSelect}
        onOpenUsage={() => useRightPanelTabsStore.getState().openTab("usage")}
        onOpenTerminal={onSelect}
        terminalAvailable
        terminalShortcutLabel={null}
      />,
    );
    try {
      await page.getByRole("button", { name: "Open another right panel tab" }).click();
      const menuLabels = page
        .getByRole("menuitem")
        .all()
        .map((item) => item.element().textContent);
      expect(menuLabels.indexOf("Usage")).toBeGreaterThanOrEqual(0);
      expect(menuLabels.indexOf("Usage")).toBeLessThan(menuLabels.indexOf("System"));
      const usageMenuItem = page.getByRole("menuitem", { name: "Usage", exact: true });
      expect(
        usageMenuItem.element().querySelector("svg.lucide-chart-no-axes-combined"),
      ).not.toBeNull();
      await usageMenuItem.click();
      expect(useRightPanelTabsStore.getState().activeTabId).toBe("usage");
      expect(useRightPanelTabsStore.getState().openTabs).toEqual(["files", "system", "usage"]);
      const usageTab = page.getByRole("button", { name: "Usage", exact: true });
      await expect.element(usageTab).toBeVisible();
      expect(usageTab.element().querySelector("svg.lucide-chart-no-axes-combined")).not.toBeNull();
      await page.getByRole("button", { name: "Files", exact: true }).click();
      expect(useRightPanelTabsStore.getState().activeTabId).toBe("files");
      await page.getByRole("button", { name: "Usage", exact: true }).click();
      expect(useRightPanelTabsStore.getState().activeTabId).toBe("usage");
      await page.getByRole("button", { name: "Close Usage tab" }).click();
      expect(useRightPanelTabsStore.getState().openTabs).toEqual(["files", "system"]);
    } finally {
      await mounted.unmount();
    }
  });
});
