import type { BrowserWindow, WebContents } from "electron";

/**
 * Broad app renderers (full preload). `isTrusted`, `all()` and
 * `broadRendererWindows()` (connectivity/update/backend-startup broadcasts,
 * menu actions) cover only these.
 */
export const desktopWindowRoles = ["main", "mascot", "compact-chat"] as const;
/**
 * Restricted computer-use safety surface (Stop/status/notice). It never loads
 * the broad preload and is authorized only for its own channels.
 */
export const COMPUTER_USE_SAFETY_ROLE = "computer-use-stop" as const;
export type DesktopWindowRole =
  | (typeof desktopWindowRoles)[number]
  | typeof COMPUTER_USE_SAFETY_ROLE;

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

  /** A broad app renderer; the restricted safety role is never "trusted" here. */
  isTrusted(webContents: WebContents): boolean {
    const role = this.getRole(webContents);
    return role !== null && role !== COMPUTER_USE_SAFETY_ROLE;
  }

  all(): BrowserWindow[] {
    return desktopWindowRoles.flatMap((role) => {
      const window = this.get(role);
      return window ? [window] : [];
    });
  }
}
