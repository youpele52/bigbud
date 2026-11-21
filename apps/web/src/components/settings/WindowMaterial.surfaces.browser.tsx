import "../../index.css";

import { ThreadId } from "@bigbud/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("~/rpc/nativeApi", () => ({
  ensureNativeApi: () => ({}),
  readNativeApi: () => undefined,
}));

import { useCommandPaletteStore, useSearchStore } from "../../stores/ui";
import { AlertDialog, AlertDialogPopup, AlertDialogTitle } from "../ui/alert-dialog";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Sheet, SheetPopup, SheetTitle } from "../ui/sheet";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { CommandPaletteDialogContent } from "../layout/CommandPalette.content";
import { SearchPaletteDialogContent } from "../layout/SearchPalette.content";

const html = document.documentElement;

/** Alpha of a computed colour: Chromium serialises colour mixes as `color(srgb r g b / a)`. */
function alphaOfColor(color: string): number {
  const alpha =
    /\/\s*([\d.]+)\)$/.exec(color)?.[1] ?? /rgba\([^)]*,\s*([\d.]+)\)$/.exec(color)?.[1];
  return alpha === undefined ? 1 : Number(alpha);
}

function alphaOf(token: string): number {
  const probe = document.createElement("div");
  if (token.startsWith("--")) probe.style.backgroundColor = `var(${token})`;
  else probe.dataset.slot = token;
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return alphaOfColor(color);
}

function backgroundAlpha(selector: string): number {
  const element = document.querySelector(selector);
  expect(element, selector).not.toBeNull();
  return alphaOfColor(getComputedStyle(element!).backgroundColor);
}

async function renderInRouter(children: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => children }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** The palettes draw their input row and result list on one rounded panel. */
const PALETTE_PANEL = '[class*="rounded-[20px]"]';

describe("window material surfaces", () => {
  afterEach(() => {
    delete html.dataset.desktopShell;
    delete html.dataset.windowMaterial;
    html.classList.remove("dark");
  });

  it("keeps every surface opaque while the material is solid", () => {
    html.dataset.desktopShell = "macos";
    html.dataset.windowMaterial = "solid";
    for (const token of ["--background", "--card", "--popover", "--app-shell-pane-fill"]) {
      expect(alphaOf(token)).toBe(1);
    }
  });

  it("makes the whole app surface translucent while the material is translucent", () => {
    html.dataset.desktopShell = "macos";
    html.dataset.windowMaterial = "translucent";
    for (const dark of [false, true]) {
      html.classList.toggle("dark", dark);
      expect(alphaOf("--background")).toBeCloseTo(dark ? 0.64 : 0.72, 2);
      expect(alphaOf("--app-shell-side-panel-background")).toBeCloseTo(dark ? 0.56 : 0.8, 2);
      expect(alphaOf("--card")).toBeCloseTo(0.4, 2);
      expect(alphaOf("--popover")).toBeCloseTo(0.92, 2);
      expect(alphaOf("--app-shell-pane-fill")).toBe(0);
      expect(alphaOf("--app-shell-header-background")).toBe(0);
      expect(alphaOf("--background-solid")).toBe(1);
    }
  });

  it("keeps switch thumbs solid on their coloured track", () => {
    html.dataset.desktopShell = "macos";
    html.dataset.windowMaterial = "translucent";
    expect(alphaOf("switch-thumb")).toBe(1);
  });
});

describe("palettes, dialogs, menus, popovers and tooltips stay opaque in every window material", () => {
  afterEach(() => {
    delete html.dataset.desktopShell;
    delete html.dataset.windowMaterial;
    html.classList.remove("dark");
    useSearchStore.setState({ searchOpen: false, focusRequest: null });
    useCommandPaletteStore.setState({ open: false });
    document.body.innerHTML = "";
  });

  for (const material of ["solid", "translucent"] as const) {
    for (const dark of [false, true]) {
      const mode = `${material}, ${dark ? "dark" : "light"}`;
      const setMaterial = () => {
        html.dataset.desktopShell = "macos";
        html.dataset.windowMaterial = material;
        html.classList.toggle("dark", dark);
      };

      it(`paints dialog, alert dialog and sheet popups opaque (${mode})`, async () => {
        setMaterial();
        const mounted = await render(
          <>
            <Dialog open>
              <DialogPopup>
                <DialogTitle>Dialog</DialogTitle>
              </DialogPopup>
            </Dialog>
            <AlertDialog open>
              <AlertDialogPopup>
                <AlertDialogTitle>Alert dialog</AlertDialogTitle>
              </AlertDialogPopup>
            </AlertDialog>
            <Sheet open>
              <SheetPopup>
                <SheetTitle>Sheet</SheetTitle>
              </SheetPopup>
            </Sheet>
          </>,
        );
        try {
          for (const slot of ["dialog-popup", "alert-dialog-popup", "sheet-popup"]) {
            await vi.waitFor(() => expect(backgroundAlpha(`[data-slot="${slot}"]`)).toBe(1));
          }
        } finally {
          await mounted.unmount();
        }
      });

      it(`paints menu, popover and tooltip popups opaque (${mode})`, async () => {
        setMaterial();
        const mounted = await render(
          <>
            <Menu open>
              <MenuTrigger>Menu</MenuTrigger>
              <MenuPopup>
                <MenuItem>Item</MenuItem>
              </MenuPopup>
            </Menu>
            <Popover open>
              <PopoverTrigger>Popover</PopoverTrigger>
              <PopoverPopup>Popover body</PopoverPopup>
            </Popover>
            <Tooltip open>
              <TooltipTrigger>Tooltip</TooltipTrigger>
              <TooltipPopup>Tooltip body</TooltipPopup>
            </Tooltip>
          </>,
        );
        try {
          for (const slot of ["menu-popup", "popover-popup", "tooltip-popup"]) {
            await vi.waitFor(() => expect(backgroundAlpha(`[data-slot="${slot}"]`)).toBe(1));
          }
        } finally {
          await mounted.unmount();
        }
      });

      it(`paints the search palette panel opaque (${mode})`, async () => {
        setMaterial();
        useSearchStore.setState({ searchOpen: true, focusRequest: null });
        const mounted = await renderInRouter(
          <SearchPaletteDialogContent activeThreadId={ThreadId.makeUnsafe("material-thread")} />,
        );
        try {
          const panel = `[data-testid="search-palette"] ${PALETTE_PANEL}`;
          await vi.waitFor(() => expect(backgroundAlpha(panel)).toBe(1));
        } finally {
          await mounted.unmount();
        }
      });

      it(`paints the command palette panel opaque (${mode})`, async () => {
        setMaterial();
        useCommandPaletteStore.setState({ open: true });
        const mounted = await renderInRouter(<CommandPaletteDialogContent />);
        try {
          const panel = `[data-testid="command-palette"] ${PALETTE_PANEL}`;
          await vi.waitFor(() => expect(backgroundAlpha(panel)).toBe(1));
        } finally {
          await mounted.unmount();
        }
      });
    }
  }
});
