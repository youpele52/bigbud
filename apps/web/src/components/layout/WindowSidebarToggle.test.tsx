import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_BINDINGS } from "../../models/keybindings/keybindings.models.test.helpers";

vi.mock("../../rpc/serverState", async () => {
  const actual =
    await vi.importActual<typeof import("../../rpc/serverState")>("../../rpc/serverState");
  return { ...actual, useServerKeybindings: () => DEFAULT_BINDINGS };
});

import { SidebarProvider } from "../ui/sidebar";
import { WindowSidebarToggle } from "./WindowSidebarToggle";

const renderToggle = (open: boolean) =>
  renderToStaticMarkup(
    <SidebarProvider defaultOpen={open}>
      <WindowSidebarToggle />
    </SidebarProvider>,
  );

const toggleButton = (markup: string) =>
  markup.match(/<button[^>]*aria-label="Toggle sidebar"[^>]*>/)?.[0] ?? "";

describe("WindowSidebarToggle", () => {
  it("is fixed beside the traffic lights and clickable inside the drag region", () => {
    const button = toggleButton(renderToggle(true));
    expect(button).toContain("fixed");
    expect(button).toContain("top-[14px]");
    // Horizontal position is in window points, so it tracks the traffic lights at any zoom.
    expect(button).toContain("left-[calc(90px/var(--window-zoom,1))]");
    expect(button).toContain("[-webkit-app-region:no-drag]");
  });

  it("is a plain icon: the open state adds no background", () => {
    expect(toggleButton(renderToggle(true))).toContain("data-pressed:bg-transparent");
  });

  it("shows whether the sidebar is open", () => {
    expect(toggleButton(renderToggle(true))).toContain('aria-pressed="true"');
    expect(toggleButton(renderToggle(false))).toContain('aria-pressed="false"');
  });
});
