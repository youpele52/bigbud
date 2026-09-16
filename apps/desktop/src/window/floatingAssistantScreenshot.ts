import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { dialog, screen, shell, type BrowserWindow } from "electron";
import { MACOS_SCREEN_RECORDING_SETTINGS_URL } from "@bigbud/shared/screenRecording";

import { desktopIpcChannels } from "../main.channels";
import type { DesktopWindowRegistry } from "./DesktopWindowRegistry";
import { CompactScreenshotHandoff } from "./compactScreenshotHandoff";
import {
  captureDesktopScreenshot,
  requireScreenRecordingPermission,
  ScreenRecordingPermissionError,
} from "./desktopScreenshot";

interface FloatingScreenshotOptions {
  readonly registry: DesktopWindowRegistry;
  readonly isEnabled: () => boolean;
  readonly openChat: () => Promise<BrowserWindow>;
}

export class FloatingAssistantScreenshot {
  readonly handoff = new CompactScreenshotHandoff();
  #running = false;
  #capturing = false;
  #generation = 0;

  constructor(private readonly options: FloatingScreenshotOptions) {}

  get isCapturing(): boolean {
    return this.#capturing;
  }

  clear(): void {
    this.#generation += 1;
    this.handoff.clear();
  }

  async request(): Promise<void> {
    if (this.#running || !this.options.isEnabled()) return;
    this.#running = true;
    const generation = this.#generation;
    const isCurrent = () => generation === this.#generation && this.options.isEnabled();
    const hidden: BrowserWindow[] = [];
    const restoreHidden = () => {
      if (!isCurrent()) return;
      for (const window of hidden) {
        if (!window.isDestroyed() && !window.isVisible()) window.showInactive();
      }
    };
    try {
      if (!this.handoff.pending) {
        requireScreenRecordingPermission(process.platform);
        const mascot = this.options.registry.get("mascot");
        if (!mascot) return;
        const display = screen.getDisplayMatching(mascot.getBounds());
        const threadId = this.handoff.selectedThreadId;
        this.#capturing = true;
        for (const role of ["mascot", "compact-chat"] as const) {
          const window = this.options.registry.get(role);
          if (window?.isVisible()) {
            hidden.push(window);
            window.hide();
          }
        }
        // Give the native menu and compositor time to remove the floating windows.
        await delay(200);
        if (!isCurrent()) return;
        const image = await captureDesktopScreenshot(display);
        if (!isCurrent()) return;
        const id = randomUUID();
        this.handoff.put({
          ...image,
          id,
          threadId,
          name: `Screenshot-${new Date().toISOString().replaceAll(":", "-")}-${id.slice(0, 8)}.jpg`,
        });
      }
      this.#capturing = false;
      restoreHidden();
      const chat = await this.options.openChat();
      if (isCurrent() && !chat.isDestroyed()) {
        chat.webContents.send(desktopIpcChannels.compactScreenshotAvailable);
      }
    } catch (error) {
      this.#capturing = false;
      restoreHidden();
      if (isCurrent()) await this.showError(error);
    } finally {
      this.#capturing = false;
      restoreHidden();
      this.#running = false;
    }
  }

  private async showError(error: unknown): Promise<void> {
    const permissionDenied = error instanceof ScreenRecordingPermissionError;
    try {
      const result = await dialog.showMessageBox({
        type: "error",
        title: "Screenshot could not be added",
        message: "Screenshot could not be added",
        detail: error instanceof Error ? error.message : "Screen capture failed. Try again.",
        buttons: permissionDenied ? ["Open Screen Recording settings", "Cancel"] : ["OK"],
        defaultId: 0,
        cancelId: permissionDenied ? 1 : 0,
        noLink: true,
      });
      if (permissionDenied && result.response === 0) {
        await shell.openExternal(MACOS_SCREEN_RECORDING_SETTINGS_URL);
      }
    } catch (reportError) {
      console.error("[desktop] screenshot error could not be displayed", reportError);
    }
  }
}
