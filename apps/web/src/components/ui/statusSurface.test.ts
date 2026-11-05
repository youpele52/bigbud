import { describe, expect, it } from "vitest";
import { statusSurfaceAccent } from "./statusSurface";

describe("status surface accents", () => {
  it.each([
    [undefined, "muted-foreground"],
    ["default", "muted-foreground"],
    ["info", "muted-foreground"],
    ["unknown", "muted-foreground"],
    ["loading", "info-foreground"],
    ["success", "success"],
    ["warning", "warning"],
    ["error", "destructive"],
  ])("maps %s to the shared %s rail", (type, token) => {
    expect(statusSurfaceAccent(type)).toBe(`border-l-2 border-l-${token}`);
  });
});
