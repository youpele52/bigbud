import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  Menu: { buildFromTemplate: vi.fn() },
  screen: {},
  shell: { openExternal: vi.fn() },
}));

import { FloatingAssistantComputerUseStop } from "./floatingAssistantComputerUse";
import { buildMascotContextMenuTemplate } from "./floatingAssistantWindows";

function fakeMascot(id: number) {
  return { isDestroyed: () => false, webContents: { id, send: vi.fn() } };
}

function stopWith(mascot: ReturnType<typeof fakeMascot> | null) {
  let current = mascot;
  const stop = new FloatingAssistantComputerUseStop({ get: () => current as never });
  return { stop, replace: (next: ReturnType<typeof fakeMascot> | null) => (current = next) };
}

const actions = () => ({
  onStopComputerUse: vi.fn(),
  onDisable: vi.fn(),
  onHideMascot: vi.fn(),
  onOpenChat: vi.fn(),
  onScreenshot: vi.fn(),
  onOpenMain: vi.fn(),
  onQuit: vi.fn(),
  onRestart: vi.fn(),
});

describe("mascot Stop computer use", () => {
  it("hides the item while no computer use is active", () => {
    const labels = buildMascotContextMenuTemplate({ ...actions(), computerUseActive: false }).map(
      (item) => ("label" in item ? item.label : item.type),
    );
    expect(labels).not.toContain("Stop computer use");
    expect(labels[0]).toBe("Open chat");
  });

  it("puts the item first, before a separator, and wires its click", () => {
    const handlers = actions();
    const template = buildMascotContextMenuTemplate({ ...handlers, computerUseActive: true });
    expect(template.slice(0, 3).map((item) => ("label" in item ? item.label : item.type))).toEqual([
      "Stop computer use",
      "separator",
      "Open chat",
    ]);
    (template[0] as { click: () => void }).click();
    expect(handlers.onStopComputerUse).toHaveBeenCalledOnce();
    expect(handlers.onQuit).not.toHaveBeenCalled();
  });

  it("follows the current mascot's reports as computer use starts and stops", () => {
    const { stop } = stopWith(fakeMascot(7));
    expect(stop.isActive).toBe(false);
    expect(stop.setActive(7, true)).toBe(true);
    expect(stop.isActive).toBe(true);
    expect(stop.setActive(7, false)).toBe(true);
    expect(stop.isActive).toBe(false);
  });

  it("ignores reports from any other window and drops a replaced mascot's report", () => {
    const { stop, replace } = stopWith(fakeMascot(7));
    expect(stop.setActive(8, true)).toBe(false);
    expect(stop.isActive).toBe(false);
    stop.setActive(7, true);
    replace(fakeMascot(9));
    expect(stop.isActive).toBe(false);
    replace(null);
    expect(stop.setActive(7, true)).toBe(false);
  });

  it("asks the mascot renderer to stop, and does nothing without a mascot", () => {
    const mascot = fakeMascot(7);
    const { stop, replace } = stopWith(mascot);
    expect(stop.requestStop()).toBe(true);
    expect(mascot.webContents.send).toHaveBeenCalledExactlyOnceWith(
      "desktop:stop-computer-use-requested",
    );
    replace(null);
    expect(stop.requestStop()).toBe(false);
  });
});
