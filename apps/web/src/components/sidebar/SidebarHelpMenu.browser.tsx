import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { SidebarProvider } from "../ui/sidebar";

const openBrowserPanelMock = vi.hoisted(() => vi.fn());

vi.mock("~/stores/browser/browserPanel.actions", () => ({
  openBrowserPanel: openBrowserPanelMock,
}));

import { SidebarHelpMenu } from "./SidebarHelpMenu";

const helpDestinations = [
  ["Getting started", "https://bigbud.app/docs/#getting-started"],
  ["Using bigbud", "https://bigbud.app/docs/#using-bigbud"],
  ["What's new", "https://bigbud.app/changelog/"],
  ["Keyboard shortcuts", "https://bigbud.app/docs/#6-keyboard-shortcuts"],
  ["Tutorials", "https://www.youtube.com/@bigbudapp"],
  ["Follow bigbud on X", "https://x.com/bigbudapp"],
] as const;

async function mountHelpMenu() {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <SidebarProvider defaultOpen>
      <SidebarHelpMenu />
    </SidebarProvider>,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
  };
}

describe("SidebarHelpMenu", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    openBrowserPanelMock.mockReset();
  });

  it("opens each help destination in the in-app browser", async () => {
    await using _ = await mountHelpMenu();

    for (const [label, url] of helpDestinations) {
      await page.getByLabelText("Help").click();
      await page.getByRole("menuitem", { name: label }).click();
      expect(openBrowserPanelMock).toHaveBeenLastCalledWith({ url });
    }
  });
});
