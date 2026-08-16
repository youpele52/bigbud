import type { BrowserWindow, WebContents } from "electron";

export const desktopWindowRoles = ["main", "mascot", "compact-chat"] as const;
export type DesktopWindowRole = (typeof desktopWindowRoles)[number];

/** Tracks trusted desktop renderers; URLs are presentation, never authorization. */
export class DesktopWindowRegistry {
  readonly #windows = new Map<DesktopWindowRole, BrowserWindow>();
  readonly #rolesByWebContentsId = new Map<number, DesktopWindowRole>();

  register(role: DesktopWindowRole, window: BrowserWindow): void {
    const webContentsId = window.webContents.id;
    this.#windows.set(role, window);
    this.#rolesByWebContentsId.set(webContentsId, role);
    window.once("closed", () => {
      if (this.#windows.get(role) === window) this.#windows.delete(role);
      this.#rolesByWebContentsId.delete(webContentsId);
    });
  }

  get(role: DesktopWindowRole): BrowserWindow | null {
    const window = this.#windows.get(role);
    return window && !window.isDestroyed() ? window : null;
  }

  getRole(webContents: WebContents): DesktopWindowRole | null {
    return this.#rolesByWebContentsId.get(webContents.id) ?? null;
  }

  isTrusted(webContents: WebContents): boolean {
    return this.getRole(webContents) !== null;
  }

  all(): BrowserWindow[] {
    return desktopWindowRoles.flatMap((role) => {
      const window = this.get(role);
      return window ? [window] : [];
    });
  }
}
