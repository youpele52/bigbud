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

describe("Files panel navigation icons", () => {
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
        onCloseTerminal={onSelect}
        onOpenNewBrowserTab={onSelect}
        onOpenFiles={onOpenFiles}
        onOpenSystem={onSelect}
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
});
