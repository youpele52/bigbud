import { describe, expect, it } from "vitest";
import { getSafeWindowMaterial, resolveWindowMaterial } from "./windowMaterial.logic";

const system = {
  platform: "darwin",
  systemVersion: "26.1.0",
  reducedTransparency: false,
  highContrast: false,
};

describe("automatic window material", () => {
  it.each(["26.0", "26.1.0", "27.0.0"])("uses translucency on macOS %s", (systemVersion) => {
    expect(resolveWindowMaterial("automatic", { ...system, systemVersion })).toBe("translucent");
  });

  it.each(["15.7.0", "14.6", "", "unknown"])(
    "uses solid on older or unknown macOS %s",
    (systemVersion) => {
      expect(resolveWindowMaterial("automatic", { ...system, systemVersion })).toBe("solid");
    },
  );

  it.each([
    { reducedTransparency: true, highContrast: false },
    { reducedTransparency: false, highContrast: true },
    { reducedTransparency: true, highContrast: true },
  ])("uses solid for accessibility preferences %o", (preferences) => {
    expect(resolveWindowMaterial("automatic", { ...system, ...preferences })).toBe("solid");
  });

  it.each(["automatic", "solid", "translucent"] as const)(
    "keeps %s solid outside macOS",
    (mode) => {
      for (const platform of ["win32", "linux"]) {
        expect(resolveWindowMaterial(mode, { ...system, platform })).toBe("solid");
      }
    },
  );

  it("preserves manual overrides regardless of system preferences or macOS version", () => {
    expect(resolveWindowMaterial("solid", system)).toBe("solid");
    expect(
      resolveWindowMaterial("translucent", {
        ...system,
        systemVersion: "15.0",
        reducedTransparency: true,
        highContrast: true,
      }),
    ).toBe("translucent");
  });

  it("accepts only supported preference values", () => {
    for (const mode of ["automatic", "solid", "translucent"]) {
      expect(getSafeWindowMaterial(mode)).toBe(mode);
    }
    for (const value of [undefined, null, false, {}, "glass"]) {
      expect(getSafeWindowMaterial(value)).toBeNull();
    }
  });
});
