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

  it("upgrades saved Meslo from the oldest app settings without changing font size", () => {
    expect(
      buildLegacyClientSettingsMigrationPatch({
        terminalFontFamily: "meslo-nerd-font-mono",
        terminalFontSize: 16,
      }),
    ).toEqual({ terminalFontFamily: "jetbrains-mono-nerd-font", terminalFontSize: 16 });
  });

  it("does not include the context window warning threshold (no legacy migration)", () => {
    const patch = buildLegacyClientSettingsMigrationPatch({
      contextWindowWarningThresholdTokens: 200_000,
    });

    expect(patch).not.toHaveProperty("contextWindowWarningThresholdTokens");
  });
});
