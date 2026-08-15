import { describe, expect, it, vi } from "vitest";

import { DesktopWindowRegistry } from "./DesktopWindowRegistry";

function createWindow(id: number) {
  const handlers = new Map<string, () => void>();
  return {
    webContents: { id },
    isDestroyed: () => false,
    once: vi.fn((event: string, handler: () => void) => handlers.set(event, handler)),
    close: () => handlers.get("closed")?.(),
  };
}

describe("DesktopWindowRegistry", () => {
  it("uses registered web contents identity and clears destroyed roles", () => {
    const registry = new DesktopWindowRegistry();
    const mascot = createWindow(42);
    registry.register("mascot", mascot as never);

    expect(registry.getRole(mascot.webContents as never)).toBe("mascot");
    expect(registry.get("mascot")).toBe(mascot);

    mascot.close();

    expect(registry.getRole(mascot.webContents as never)).toBeNull();
    expect(registry.get("mascot")).toBeNull();
  });
});
