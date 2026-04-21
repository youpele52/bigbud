import { describe, expect, it } from "vitest";
import { buildLegacyClientSettingsMigrationPatch } from "./useSettings";

describe("buildLegacyClientSettingsMigrationPatch", () => {
  it("migrates archive confirmation from legacy local settings", () => {
    expect(
      buildLegacyClientSettingsMigrationPatch({
        confirmThreadArchive: true,
        confirmThreadDelete: false,
      }),
    ).toEqual({
      confirmThreadArchive: true,
      confirmThreadDelete: false,
    });
  });

  it("migrates terminal appearance settings from legacy local settings", () => {
    expect(
      buildLegacyClientSettingsMigrationPatch({
        terminalFontFamily: "system-monospace",
        terminalFontSize: 14,
      }),
    ).toEqual({
      terminalFontFamily: "system-monospace",
      terminalFontSize: 14,
    });
  });

  it("drops invalid legacy terminal appearance settings", () => {
    expect(
      buildLegacyClientSettingsMigrationPatch({
        terminalFontFamily: "broken",
        terminalFontSize: 24,
      }),
    ).toEqual({});
  });
});
