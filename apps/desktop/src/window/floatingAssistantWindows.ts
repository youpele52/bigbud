import * as Path from "node:path";

import { BrowserWindow, Menu, screen, shell } from "electron";

import type { DesktopWindowRegistry } from "./DesktopWindowRegistry";
import type { DesktopPreferencesStore } from "./desktopPreferences";
import { clampBounds, COMPACT_CHAT_MIN_SIZE, compactChatBounds, MASCOT_SIZE } from "./mascotBounds";
import { getIconOption } from "./windowManager";

export interface FloatingAssistantWindowsDeps {
  readonly desktopDir: string;
  readonly desktopScheme: string;
  readonly getSafeExternalUrl: (url: unknown) => string | null;
  readonly isDevelopment: boolean;
  readonly onOpenMain: () => void;
  readonly onQuit: () => void;
  readonly preferences: DesktopPreferencesStore;
  readonly registry: DesktopWindowRegistry;
  readonly resolveIconPath: (ext: "ico" | "icns" | "png") => string | null;
  readonly spellcheckEnabled: boolean;
}

export class FloatingAssistantWindows {
  #mascotCreation: Promise<BrowserWindow> | null = null;
  #compactCreation: Promise<BrowserWindow> | null = null;
  #mascotDragOffset: { x: number; y: number } | null = null;
  #mascotBoundsSaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: FloatingAssistantWindowsDeps) {}

  ensureMascot(): Promise<BrowserWindow> {
    const existing = this.deps.registry.get("mascot");
    if (existing) return Promise.resolve(existing);
    if (!this.#mascotCreation) {
      this.#mascotCreation = Promise.resolve(this.createMascot()).finally(() => {
        this.#mascotCreation = null;
      });
    }
    return this.#mascotCreation;
  }

  async openCompactChat(): Promise<BrowserWindow> {
    const existing = this.deps.registry.get("compact-chat");
    if (existing) {
      existing.show();
      existing.focus();
      return existing;
    }
    if (!this.#compactCreation) {
      this.#compactCreation = this.ensureMascot()
        .then((mascot) => this.createCompactChat(mascot))
        .finally(() => {
          this.#compactCreation = null;
        });
    }
    return this.#compactCreation;
  }

  hideMascot(): void {
    this.deps.preferences.update({ mascotVisible: false });
    this.deps.registry.get("mascot")?.hide();
  }

  beginMascotDrag(point: unknown): boolean {
    const mascot = this.deps.registry.get("mascot");
    if (!mascot || !isPoint(point)) return false;
    const bounds = mascot.getBounds();
    this.#mascotDragOffset = { x: point.x - bounds.x, y: point.y - bounds.y };
    return true;
  }

  moveMascot(point: unknown): boolean {
    const mascot = this.deps.registry.get("mascot");
    if (!mascot || !this.#mascotDragOffset || !isPoint(point)) return false;
    mascot.setPosition(
      Math.round(point.x - this.#mascotDragOffset.x),
      Math.round(point.y - this.#mascotDragOffset.y),
    );
    return true;
  }

  hideCompactChat(): void {
    this.deps.registry.get("compact-chat")?.hide();
  }

  disable(): void {
    this.flushMascotBounds();
    this.deps.preferences.update({ floatingAssistantEnabled: false, mascotVisible: false });
    this.deps.registry.get("compact-chat")?.destroy();
    this.deps.registry.get("mascot")?.destroy();
  }

  destroyForQuit(): void {
    this.flushMascotBounds();
    for (const window of [
      this.deps.registry.get("compact-chat"),
      this.deps.registry.get("mascot"),
    ]) {
      if (window && !window.isDestroyed()) window.destroy();
    }
  }

  private createMascot(): BrowserWindow {
    const anchor = this.deps.preferences.get().mascotBounds;
    const workArea = anchor
      ? screen.getDisplayNearestPoint(anchor).workArea
      : screen.getPrimaryDisplay().workArea;
    const bounds = clampBounds(
      {
        x: anchor?.x ?? workArea.x + workArea.width - MASCOT_SIZE - 16,
        y: anchor?.y ?? workArea.y + workArea.height - MASCOT_SIZE - 16,
        width: MASCOT_SIZE,
        height: MASCOT_SIZE,
      },
      workArea,
    );
    const window = new BrowserWindow({
      ...bounds,
      backgroundColor: "#00000000",
      frame: false,
      hasShadow: false,
      transparent: process.platform !== "linux",
      show: false,
      focusable: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: process.platform !== "darwin",
      alwaysOnTop: process.env.XDG_SESSION_TYPE !== "wayland",
      ...getIconOption(this.deps.resolveIconPath),
      webPreferences: this.webPreferences(false),
    });
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.deps.registry.register("mascot", window);
    window.on("moved", () => {
      this.scheduleMascotBoundsSave(window);
    });
    window.on("close", (event) => {
      if (!window.isDestroyed()) {
        event.preventDefault();
        this.hideMascot();
      }
    });
    this.load(window, "mascot");
    return window;
  }

  private scheduleMascotBoundsSave(window: BrowserWindow): void {
    if (this.#mascotBoundsSaveTimer !== null) clearTimeout(this.#mascotBoundsSaveTimer);
    this.#mascotBoundsSaveTimer = setTimeout(() => {
      this.#mascotBoundsSaveTimer = null;
      if (window.isDestroyed()) return;
      const next = window.getBounds();
      this.deps.preferences.update({ mascotBounds: { x: next.x, y: next.y } });
    }, 150);
  }

  private flushMascotBounds(): void {
    if (this.#mascotBoundsSaveTimer === null) return;
    clearTimeout(this.#mascotBoundsSaveTimer);
    this.#mascotBoundsSaveTimer = null;
    const mascot = this.deps.registry.get("mascot");
    if (!mascot || mascot.isDestroyed()) return;
    const next = mascot.getBounds();
    this.deps.preferences.update({ mascotBounds: { x: next.x, y: next.y } });
  }

  private createCompactChat(mascot: BrowserWindow): BrowserWindow {
    if (!this.deps.preferences.get().floatingAssistantEnabled || mascot.isDestroyed()) {
      throw new Error("Cannot open compact chat while the floating assistant is disabled.");
    }
    const mascotBounds = mascot.getBounds();
    const display = screen.getDisplayMatching(mascotBounds);
    const bounds = compactChatBounds(mascotBounds, display.workArea);
    const window = new BrowserWindow({
      ...bounds,
      minWidth: Math.min(COMPACT_CHAT_MIN_SIZE.width, display.workArea.width),
      minHeight: Math.min(COMPACT_CHAT_MIN_SIZE.height, display.workArea.height),
      show: false,
      title: "bigbud",
      autoHideMenuBar: true,
      alwaysOnTop: process.env.XDG_SESSION_TYPE !== "wayland",
      ...getIconOption(this.deps.resolveIconPath),
      webPreferences: this.webPreferences(true),
    });
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.deps.registry.register("compact-chat", window);
    window.on("close", (event) => {
      event.preventDefault();
      this.hideCompactChat();
    });
    this.load(window, "compact-chat");
    return window;
  }

  private webPreferences(spellcheck: boolean) {
    return {
      preload: Path.join(this.deps.desktopDir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: false,
      spellcheck: spellcheck && this.deps.spellcheckEnabled,
      webviewTag: false,
    };
  }

  private load(window: BrowserWindow, role: "mascot" | "compact-chat"): void {
    window.webContents.setWindowOpenHandler(({ url }) => {
      const externalUrl = this.deps.getSafeExternalUrl(url);
      if (externalUrl) void shell.openExternal(externalUrl);
      return { action: "deny" };
    });
    window.webContents.on("context-menu", (_event, params) => {
      if (role === "mascot") {
        Menu.buildFromTemplate([
          { label: "Open chat", click: () => void this.openCompactChat() },
          { label: "New chat", click: () => void this.openCompactChat() },
          { label: "Open bigbud", click: this.deps.onOpenMain },
          { type: "separator" },
          { label: "Hide mascot", click: () => this.hideMascot() },
          {
            label: "Disable floating assistant",
            click: () => {
              this.deps.onOpenMain();
              this.disable();
            },
          },
          { type: "separator" },
          { label: "Quit bigbud", click: this.deps.onQuit },
        ]).popup({ window });
        return;
      }
      Menu.buildFromTemplate([{ role: "copy", enabled: params.editFlags.canCopy }]).popup({
        window,
      });
    });
    window.once("ready-to-show", () => {
      if (role === "mascot") window.showInactive();
      else window.show();
    });
    const url = this.deps.isDevelopment
      ? `${process.env.VITE_DEV_SERVER_URL as string}#/?desktopWindowRole=${role}`
      : `${this.deps.desktopScheme}://app/index.html#/?desktopWindowRole=${role}`;
    void window.loadURL(url);
  }
}

function isPoint(value: unknown): value is { x: number; y: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isFinite((value as { x?: unknown }).x) &&
    Number.isFinite((value as { y?: unknown }).y)
  );
}
