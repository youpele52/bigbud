import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "./settings";

describe("web link browser preference", () => {
  it("defaults new and existing settings to enabled", () => {
    expect(DEFAULT_CLIENT_SETTINGS.openWebLinksInApp).toBe(true);
    expect(
      Schema.decodeSync(ClientSettingsSchema)({ terminalFontSize: 14 }).openWebLinksInApp,
    ).toBe(true);
  });
  it("retains explicit false", () => {
    expect(
      Schema.decodeSync(ClientSettingsSchema)({ openWebLinksInApp: false }).openWebLinksInApp,
    ).toBe(false);
  });
});
