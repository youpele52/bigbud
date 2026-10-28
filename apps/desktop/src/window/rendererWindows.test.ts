import { describe, expect, it, vi } from "vitest";

const windows = vi.hoisted(() => [] as unknown[]);
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => windows },
}));

import { COMPUTER_USE_SAFETY_ROLE } from "./DesktopWindowRegistry";
import { broadRendererWindows, configureRendererWindows } from "./rendererWindows";

const window = (id: number, destroyed = false) => ({
  isDestroyed: () => destroyed,
  webContents: { id },
});

describe("broadRendererWindows", () => {
  it("excludes the safety renderer and destroyed windows from broadcasts", () => {
    // Regression (review P3): broadcasts used getAllWindows() and reached the
    // restricted safety renderer.
    const main = window(1);
    const safety = window(2);
    const gone = window(3, true);
    windows.push(main, safety, gone);
    expect(broadRendererWindows()).toEqual([main, safety]);
    configureRendererWindows({
      getRole: (contents) => (contents.id === 2 ? COMPUTER_USE_SAFETY_ROLE : "main"),
    });
    expect(broadRendererWindows()).toEqual([main]);
  });
});
