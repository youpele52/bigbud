import type { ContextMenuItem } from "@bigbud/contracts";

import {
  createContextMenuPanel,
  focusFirstMenuButton,
  moveMenuFocus,
  positionContextMenuPanel,
} from "./fallback.panel.utils";

/**
 * Imperative DOM-based context menu for non-Electron environments.
 * Shows a positioned dropdown and returns a promise that resolves
 * with the clicked item id, or null if dismissed. Items with children open one submenu level.
 */
export function showContextMenuFallback<T extends string>(
  items: readonly ContextMenuItem<T>[],
  position?: { x: number; y: number },
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:9999";
    let submenu: { panel: HTMLElement; parent: HTMLButtonElement } | null = null;

    function closeSubmenu(focusParent: boolean) {
      if (!submenu) return;
      submenu.panel.remove();
      submenu.parent.setAttribute("aria-expanded", "false");
      if (focusParent) submenu.parent.focus();
      submenu = null;
    }

    function cleanup(result: T | null) {
      document.removeEventListener("keydown", onKeyDown);
      closeSubmenu(false);
      overlay.remove();
      menu.remove();
      previousFocus?.focus();
      resolve(result);
    }

    function openSubmenu(parent: HTMLButtonElement, children: readonly ContextMenuItem<T>[]) {
      if (submenu?.parent === parent) return;
      closeSubmenu(false);
      const panel = createContextMenuPanel(children, {
        onSelect: cleanup,
        onOpenSubmenu: () => undefined,
      });
      document.body.appendChild(panel);
      const rect = parent.getBoundingClientRect();
      positionContextMenuPanel(panel, { x: rect.right, y: rect.top - 4 }, rect.left);
      parent.setAttribute("aria-expanded", "true");
      submenu = { panel, parent };
    }

    const menu = createContextMenuPanel(items, {
      onSelect: cleanup,
      onOpenSubmenu: (parent, children, viaKeyboard) => {
        openSubmenu(parent, children);
        if (viaKeyboard && submenu) focusFirstMenuButton(submenu.panel);
      },
      onHoverPlainItem: () => closeSubmenu(false),
    });

    function onKeyDown(event: KeyboardEvent) {
      const inSubmenu = submenu !== null && submenu.panel.contains(document.activeElement);
      const panel = inSubmenu && submenu ? submenu.panel : menu;
      if (event.key === "Escape") {
        event.preventDefault();
        if (inSubmenu) closeSubmenu(true);
        else cleanup(null);
      } else if (event.key === "ArrowLeft" && inSubmenu) {
        event.preventDefault();
        closeSubmenu(true);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveMenuFocus(panel, event.key === "ArrowDown" ? 1 : -1);
      }
    }

    overlay.addEventListener("mousedown", () => cleanup(null));
    document.addEventListener("keydown", onKeyDown);
    document.body.appendChild(overlay);
    document.body.appendChild(menu);
    positionContextMenuPanel(menu, { x: position?.x ?? 0, y: position?.y ?? 0 });
  });
}
