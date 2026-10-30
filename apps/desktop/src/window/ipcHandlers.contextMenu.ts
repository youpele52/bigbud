import { BrowserWindow, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import type { ContextMenuItem } from "@bigbud/contracts";
import { getDestructiveMenuIcon } from "../env/pathResolver";
import { authorizedHandle, BROAD_RENDERER_ROLES } from "./ipcAuthorization";
import {
  buildContextMenuTemplate,
  normalizeContextMenuItems,
  type ContextMenuTemplateItem,
} from "./ipcHandlers.contextMenu.items";

export function registerContextMenuIpcHandler(
  channel: string,
  getMainWindow: () => BrowserWindow | null,
): void {
  authorizedHandle(
    channel,
    BROAD_RENDERER_ROLES,
    async (event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = normalizeContextMenuItems(items);
      if (normalizedItems.length === 0) return null;

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? { x: Math.floor(position.x), y: Math.floor(position.y) }
          : null;

      const window = BrowserWindow.fromWebContents(event.sender) ?? getMainWindow();
      if (!window) return null;

      return new Promise<string | null>((resolve) => {
        const toElectron = (item: ContextMenuTemplateItem): MenuItemConstructorOptions => {
          if (item.type === "separator") return { type: "separator" };
          const destructiveIcon = item.destructive ? getDestructiveMenuIcon() : null;
          return {
            ...(item.type === "checkbox"
              ? { type: "checkbox", checked: item.checked === true }
              : {}),
            label: item.label ?? "",
            enabled: item.enabled !== false,
            ...(item.submenu ? { submenu: item.submenu.map(toElectron) } : {}),
            ...(item.id !== undefined ? { click: () => resolve(item.id!) } : {}),
            ...(destructiveIcon ? { icon: destructiveIcon } : {}),
          };
        };
        const template = buildContextMenuTemplate(normalizedItems).map(toElectron);
        const menu = Menu.buildFromTemplate(template);
        menu.popup({ window, ...popupPosition, callback: () => resolve(null) });
      });
    },
  );
}
