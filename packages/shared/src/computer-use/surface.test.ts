import { describe, expect, it } from "vitest";

import {
  DESKTOP_ONLY_COMPUTER_USE_ACTIONS,
  isComputerUseSurface,
  resolveComputerUseSurface,
} from "./surface";

describe("resolveComputerUseSurface", () => {
  it("keeps the browser default for shared actions and pins desktop-only actions", () => {
    for (const action of ["click", "type", "key", "scroll", "drag", "wait", "capture"]) {
      expect(resolveComputerUseSurface(action, undefined)).toBe("browser");
      expect(resolveComputerUseSurface(action, "desktop")).toBe("desktop");
    }
    for (const action of DESKTOP_ONLY_COMPUTER_USE_ACTIONS) {
      expect(resolveComputerUseSurface(action, "browser")).toBe("desktop");
    }
    expect(DESKTOP_ONLY_COMPUTER_USE_ACTIONS.size).toBe(7);
    expect([isComputerUseSurface("desktop"), isComputerUseSurface("web")]).toEqual([true, false]);
  });
});
