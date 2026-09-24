import { BrowserWindow, ipcMain, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import type { ContextMenuItem } from "@bigbud/contracts";
import { getDestructiveMenuIcon } from "../env/pathResolver";

export function registerContextMenuIpcHandler(
  channel: string,
  getMainWindow: () => BrowserWindow | null,
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(
    channel,
    async (event, items: ContextMenuItem[], position?: { x: number; y: number }) => {
      const normalizedItems = items
        .filter((item) => typeof item.id === "string" && typeof item.label === "string")
        .map((item) => ({
          id: item.id,
          label: item.label,
          separator: item.separator === true,
          destructive: item.destructive === true,
          disabled: item.disabled === true,
        }));
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
        const template: MenuItemConstructorOptions[] = [];
        let hasInsertedDestructiveSeparator = false;
        for (const item of normalizedItems) {
          if (item.separator) {
            template.push({ type: "separator" });
            continue;
          }
          if (item.destructive && !hasInsertedDestructiveSeparator && template.length > 0) {
            template.push({ type: "separator" });
            hasInsertedDestructiveSeparator = true;
          }
          const itemOption: MenuItemConstructorOptions = {
            label: item.label,
            enabled: !item.disabled,
            click: () => resolve(item.id),
          };
          if (item.destructive) {
            const destructiveIcon = getDestructiveMenuIcon();
            if (destructiveIcon) itemOption.icon = destructiveIcon;
          }
          template.push(itemOption);
        }

        const menu = Menu.buildFromTemplate(template);
        menu.popup({ window, ...popupPosition, callback: () => resolve(null) });
      });
    },
  );
}
