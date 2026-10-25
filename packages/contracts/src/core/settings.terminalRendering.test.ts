import { expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
} from "./settings";

it("defaults omitted client settings and unified reset settings to Auto", () => {
  expect(Schema.decodeSync(ClientSettingsSchema)({}).terminalGpuAcceleration).toBe("auto");
  expect(
    Schema.decodeSync(ClientSettingsSchema)({ terminalFontSize: 14 }).terminalGpuAcceleration,
  ).toBe("auto");
  expect(DEFAULT_CLIENT_SETTINGS.terminalGpuAcceleration).toBe("auto");
  expect(DEFAULT_UNIFIED_SETTINGS.terminalGpuAcceleration).toBe("auto");
});

it("preserves explicit Off, On and Auto without migrating saved preferences", () => {
  for (const terminalGpuAcceleration of ["off", "on", "auto"] as const) {
    expect(
      Schema.decodeSync(ClientSettingsSchema)({ terminalGpuAcceleration }).terminalGpuAcceleration,
    ).toBe(terminalGpuAcceleration);
  }
  expect(() =>
    Schema.decodeUnknownSync(ClientSettingsSchema)({ terminalGpuAcceleration: "always" }),
  ).toThrow();
});

it("defaults both terminal theme slots to the app-derived bigbud theme", () => {
  const decoded = Schema.decodeSync(ClientSettingsSchema)({});
  expect(decoded.terminalThemeDark).toBe("bigbud");
  expect(decoded.terminalThemeLight).toBe("bigbud");
  expect(
    Schema.decodeSync(ClientSettingsSchema)({ terminalThemeDark: "Catppuccin Macchiato" })
      .terminalThemeDark,
  ).toBe("Catppuccin Macchiato");
});
