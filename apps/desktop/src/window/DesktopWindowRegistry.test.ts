import { describe, expect, it, vi } from "vitest";

import { COMPUTER_USE_SAFETY_ROLE, DesktopWindowRegistry } from "./DesktopWindowRegistry";

function createWindow(id: number) {
  const handlers = new Map<string, () => void>();
  const webContents = { id };
  let destroyed = false;
  return {
    get webContents() {
      if (destroyed) throw new Error("Object has been destroyed");
      return webContents;
    },
    isDestroyed: () => destroyed,
    once: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
    close: () => {
      destroyed = true;
      handlers.get("closed")?.();
    },
  };
}

describe("DesktopWindowRegistry", () => {
  it("uses registered web contents identity and clears destroyed roles", () => {
    const registry = new DesktopWindowRegistry();
    const mascot = createWindow(42);
    const mascotWebContents = mascot.webContents;
    registry.register("mascot", mascot as never);

    expect(registry.getRole(mascotWebContents as never)).toBe("mascot");
    expect(registry.get("mascot")).toBe(mascot);

    expect(() => mascot.close()).not.toThrow();

    expect(registry.getRole(mascotWebContents as never)).toBeNull();
    expect(registry.get("mascot")).toBeNull();
  });

  it("never treats the restricted safety role as a trusted broad renderer", () => {
    const registry = new DesktopWindowRegistry();
    const safety = createWindow(7);
    const main = createWindow(8);
    registry.register(COMPUTER_USE_SAFETY_ROLE, safety as never);
    registry.register("main", main as never);

    expect(registry.getRole(safety.webContents as never)).toBe(COMPUTER_USE_SAFETY_ROLE);
    expect(registry.isTrusted(safety.webContents as never)).toBe(false);
    expect(registry.isTrusted(main.webContents as never)).toBe(true);
    // Broadcast targets are broad renderers only.
    expect(registry.all()).toEqual([main]);
  });
});
