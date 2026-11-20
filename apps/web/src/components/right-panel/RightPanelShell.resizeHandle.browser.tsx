import "../../index.css";

import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import { Sidebar, SidebarInset, SidebarProvider, SidebarRail } from "../ui/sidebar";
import { RightPanelShell } from "./RightPanelShell";

/** The hovered resize line, with its offset from the panel's border pixel. */
async function hoveredLine(handle: HTMLElement, borderPixelLeft: number) {
  await userEvent.hover(handle);
  const line = getComputedStyle(handle, "::after");
  const lineLeft = handle.getBoundingClientRect().left + Number.parseFloat(line.left);
  return {
    width: line.width,
    color: line.backgroundColor,
    offsetFromBorder: lineLeft - borderPixelLeft,
  };
}

describe("right panel resize handle", () => {
  it("draws the same line as the left sidebar rail", async () => {
    await page.viewport(1280, 800);
    const screen = await render(
      <SidebarProvider>
        <Sidebar collapsible="offcanvas" resizable className="border-r border-border">
          <SidebarRail />
        </Sidebar>
        <SidebarInset className="h-dvh" />
        <RightPanelShell
          open
          width={320}
          resizeAriaLabel="Resize right panel"
          onResizePointerDown={() => undefined}
        >
          <div />
        </RightPanelShell>
      </SidebarProvider>,
    );
    const rail = document.querySelector<HTMLElement>('[data-slot="sidebar-rail"]')!;
    const sidebarRight = document
      .querySelector('[data-slot="sidebar-container"]')!
      .getBoundingClientRect().right;
    const handle = screen.getByRole("button", { name: "Resize right panel" }).element();
    const panelLeft = handle.parentElement!.getBoundingClientRect().left;

    const left = await hoveredLine(rail, sidebarRight - 1);
    const right = await hoveredLine(handle as HTMLElement, panelLeft);

    expect(right).toEqual(left);
    // A hairline over the border, as the user expects from the sidebar edge.
    expect(left.width).toBe("1px");
    expect(left.offsetFromBorder).toBe(0);
    expect(right.offsetFromBorder).toBe(0);
    // The grab area stays as wide as the rail's.
    expect(handle.getBoundingClientRect().width).toBe(rail.getBoundingClientRect().width);
    await screen.unmount();
  });
});
