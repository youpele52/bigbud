/** Interactive native check: bun run --cwd apps/desktop scripts/screenshot-smoke.mjs */
import assert from "node:assert/strict";
import { once } from "node:events";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  app,
  BrowserWindow,
  dialog,
  nativeImage,
  screen,
  systemPreferences,
  type Display,
  type Rectangle,
} from "electron";

import { DesktopWindowRegistry } from "./DesktopWindowRegistry";
import { captureDesktopScreenshot, requireScreenRecordingPermission } from "./desktopScreenshot";
import { FloatingAssistantScreenshot } from "./floatingAssistantScreenshot";
import { registerCompactScreenshotIpc } from "./ipcHandlers.compactScreenshot";

const outputDir = process.env.BIGBUD_SCREENSHOT_SMOKE_DIR;
assert.ok(outputDir, "The smoke runner must supply a temporary output directory.");
app.setPath("userData", join(outputDir, "profile"));

async function panel(bounds: Rectangle, color: string, overlay = false): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    backgroundColor: color,
    alwaysOnTop: overlay,
    webPreferences: {
      preload: join(outputDir!, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
    },
  });
  await window.loadURL(
    `data:text/html,${encodeURIComponent(`<body style="margin:0;background:${color}"></body>`)}`,
  );
  window.setAlwaysOnTop(
    overlay || process.platform === "darwin",
    overlay ? "screen-saver" : "floating",
  );
  window.show();
  return window;
}

function pixel(dataUrl: string, display: Display, px: number, py: number): number[] {
  const image = nativeImage.createFromDataURL(dataUrl);
  const size = image.getSize();
  const x = Math.round(((px - display.bounds.x) * size.width) / display.bounds.width);
  const y = Math.round(((py - display.bounds.y) * size.height) / display.bounds.height);
  const bytes = image.toBitmap();
  const index = (y * size.width + x) * 4;
  return [bytes[index + 2]!, bytes[index + 1]!, bytes[index]!];
}

function closeColor(actual: number[], expected: number[]): boolean {
  // Native monitor color profiles and JPEG encoding can shift RGB values.
  return actual.every((value, index) => Math.abs(value - expected[index]!) < 45);
}

async function verify(): Promise<void> {
  const permissions =
    process.platform === "darwin"
      ? {
          screen: systemPreferences.getMediaAccessStatus("screen"),
          accessibility: systemPreferences.isTrustedAccessibilityClient(false),
        }
      : { screen: "OS-controlled" };
  console.log("Screenshot permissions:", permissions);
  requireScreenRecordingPermission(process.platform);
  const display = screen.getPrimaryDisplay();
  const x = display.workArea.x + 50;
  const y = display.workArea.y + 50;
  const background = await panel({ x, y, width: 900, height: 600 }, "#137b47");
  const mascot = await panel({ x: x + 50, y: y + 50, width: 100, height: 100 }, "#ed2235", true);
  const compact = await panel({ x: x + 400, y: y + 100, width: 350, height: 250 }, "#2240ed", true);
  const registry = new DesktopWindowRegistry();
  registry.register("main", background);
  registry.register("mascot", mascot);
  registry.register("compact-chat", compact);
  const coordinator = new FloatingAssistantScreenshot({
    registry,
    isEnabled: () => true,
    openChat: async () => {
      compact.show();
      return compact;
    },
  });
  registerCompactScreenshotIpc(registry, coordinator.handoff);
  const readPending = "window.desktopBridge.compactChatScreenshot.getPending('native-smoke-chat')";
  assert.equal(await compact.webContents.executeJavaScript(readPending), null);
  await compact.webContents.executeJavaScript(`
    window.screenshotNotifications = 0;
    void window.desktopBridge.compactChatScreenshot.onAvailable(() => window.screenshotNotifications++);
  `);
  await delay(1_200);
  const before = await captureDesktopScreenshot(display);
  const points = [mascot, compact].map((window) => {
    const bounds = window.getBounds();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  });
  const beforeColors = points.map((point) => pixel(before.dataUrl, display, point.x, point.y));
  assert.ok(
    closeColor(beforeColors[0]!, [237, 34, 53]),
    `mascot visible before capture: ${beforeColors[0]}`,
  );
  assert.ok(
    closeColor(beforeColors[1]!, [34, 64, 237]),
    `compact chat visible before capture: ${beforeColors[1]}`,
  );
  const captureErrors: string[] = [];
  const showMessageBox = dialog.showMessageBox;
  // Capture failures must fail this check instead of leaving an unattended modal.
  dialog.showMessageBox = async (options) => {
    captureErrors.push(
      "detail" in options ? (options.detail ?? "Capture failed") : "Capture failed",
    );
    return { response: 1, checkboxChecked: false };
  };
  try {
    await coordinator.request();
  } finally {
    dialog.showMessageBox = showMessageBox;
  }
  assert.deepEqual(captureErrors, []);
  const screenshot = coordinator.handoff.read("native-smoke-chat");
  assert.ok(screenshot, "screenshot remains pending for the compact renderer");
  const afterColors = points.map((point) => pixel(screenshot.dataUrl, display, point.x, point.y));
  assert.ok(
    afterColors.every((color) => closeColor(color, [19, 123, 71])),
    "floating windows excluded from capture",
  );
  assert.ok(mascot.isVisible() && compact.isVisible(), "floating windows restored");
  assert.equal(await compact.webContents.executeJavaScript("window.screenshotNotifications"), 1);
  assert.equal(await background.webContents.executeJavaScript(readPending), null);
  const acknowledge = `window.desktopBridge.compactChatScreenshot.acknowledge(${JSON.stringify(screenshot.id)})`;
  assert.equal(await background.webContents.executeJavaScript(acknowledge), false);
  assert.deepEqual(await compact.webContents.executeJavaScript(readPending), screenshot);
  const reloaded = once(compact.webContents, "did-finish-load");
  compact.reload();
  await reloaded;
  assert.deepEqual(await compact.webContents.executeJavaScript(readPending), screenshot);
  assert.equal(await compact.webContents.executeJavaScript(acknowledge), true);
  assert.equal(coordinator.handoff.pending, false);
  console.log("Native screenshot smoke passed:", {
    platform: process.platform,
    electron: process.versions.electron,
    permissions,
    displays: screen.getAllDisplays().length,
    size: nativeImage.createFromDataURL(screenshot.dataUrl).getSize(),
    sizeBytes: screenshot.sizeBytes,
    floatingWindowsHiddenAndRestored: true,
    preloadIpcAndReload: true,
  });
}

const timeout = setTimeout(() => app.exit(2), 45_000);
void app
  .whenReady()
  .then(verify)
  .then(
    () => {
      clearTimeout(timeout);
      app.exit(0);
    },
    (error: unknown) => {
      console.error(error);
      clearTimeout(timeout);
      app.exit(1);
    },
  );
