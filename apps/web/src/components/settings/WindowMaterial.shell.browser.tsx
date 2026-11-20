import "../../index.css";

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { ContentPanelHeader, contentPanelHeaderClassName } from "../layout/ContentPanelHeader";
import { RightPanelShell } from "../right-panel/RightPanelShell";
import { Sidebar, SidebarInset, SidebarProvider } from "../ui/sidebar";

const html = document.documentElement;
// Stand-ins for the native vibrancy behind the transparent window.
const VIBRANCY_BACKDROP = { light: "rgb(236, 236, 236)", dark: "rgb(40, 40, 40)" };

/**
 * Effective colour of an element as the window shows it: every painted ancestor layer composited
 * over the backdrop, exactly as the browser stacks them. `overlay` is painted last (a border).
 */
function effectiveColor(
  element: Element,
  backdrop: string,
  overlay?: string,
): readonly [number, number, number] {
  const layers: string[] = overlay ? [overlay] : [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    // Chromium composites a backdrop filter over the original backdrop, doubling any tint.
    expect(style.backdropFilter, node.outerHTML.slice(0, 80)).toBe("none");
    layers.unshift(style.backgroundColor);
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  for (const fill of [backdrop, ...layers]) {
    context.fillStyle = fill;
    context.fillRect(0, 0, 1, 1);
  }
  const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
  return [red, green, blue];
}

const lightness = ([red, green, blue]: readonly [number, number, number]) =>
  (red + green + blue) / 3;

function Shell() {
  return (
    <SidebarProvider>
      <Sidebar collapsible="offcanvas" className="border-r border-border text-foreground">
        <div data-testid="sidebar-content" className="h-10" />
      </Sidebar>
      <SidebarInset className="h-dvh bg-background">
        <div className="flex flex-1 flex-col bg-[var(--app-shell-pane-fill)]">
          <ContentPanelHeader>
            <span data-testid="chat-header">Chat</span>
          </ContentPanelHeader>
          <div data-testid="chat-body" className="flex-1" />
        </div>
      </SidebarInset>
      <RightPanelShell open width={320}>
        <div
          className={contentPanelHeaderClassName("bg-[var(--app-shell-panel-header-background)]")}
        >
          <span data-testid="panel-header">Tabs</span>
        </div>
        <div data-testid="panel-body" className="h-40 bg-[var(--app-shell-pane-fill)]" />
      </RightPanelShell>
    </SidebarProvider>
  );
}

describe("window material shell tones", () => {
  beforeAll(async () => {
    await page.viewport(1280, 800);
  });

  afterEach(() => {
    delete html.dataset.desktopShell;
    delete html.dataset.windowMaterial;
    html.classList.remove("dark");
  });

  for (const material of ["solid", "translucent"] as const) {
    for (const theme of ["light", "dark"] as const) {
      it(`gives side panels one tone, matching dividers and a subtly deeper middle (${material}, ${theme})`, async () => {
        html.dataset.desktopShell = "macos";
        html.dataset.windowMaterial = material;
        html.classList.toggle("dark", theme === "dark");
        const screen = await render(<Shell />);
        const colorOf = (testId: string) =>
          effectiveColor(screen.getByTestId(testId).element(), VIBRANCY_BACKDROP[theme]);

        const sidebar = colorOf("sidebar-content");
        const panel = colorOf("panel-body");
        const middle = colorOf("chat-body");
        const sidebarFrame = document.querySelector('[data-slot="sidebar-container"]')!;
        const panelFrame = screen.getByTestId("panel-body").element().parentElement!;
        const sidebarEdge = effectiveColor(
          sidebarFrame,
          VIBRANCY_BACKDROP[theme],
          getComputedStyle(sidebarFrame).borderRightColor,
        );
        const panelEdge = effectiveColor(
          panelFrame,
          VIBRANCY_BACKDROP[theme],
          getComputedStyle(panelFrame).borderLeftColor,
        );
        // Headers resolve to the surface they sit on, never a separate darker strip.
        expect(colorOf("chat-header")).toEqual(middle);
        expect(colorOf("panel-header")).toEqual(panel);
        expect(sidebar).toEqual(panel);
        const step = lightness(panel) - lightness(middle);
        expect(step).toBeGreaterThanOrEqual(2);
        expect(step).toBeLessThanOrEqual(12);
        // Both dividers are the same subtle line drawn over the side tone, never the raw backdrop.
        expect(sidebarEdge).toEqual(panelEdge);
        expect(lightness(panel) - lightness(panelEdge)).toBeLessThanOrEqual(24);
        await screen.unmount();
      });
    }
  }
});
