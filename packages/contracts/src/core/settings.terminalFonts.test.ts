import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import { ClientSettingsSchema, TERMINAL_FONT_FAMILIES } from "./settings";

it("defaults missing font preferences to JetBrains Mono without resetting saved choices", () => {
  const decode = Schema.decodeSync(ClientSettingsSchema);
  expect(decode({}).terminalFontFamily).toBe("jetbrains-mono-nerd-font");
  for (const terminalFontFamily of TERMINAL_FONT_FAMILIES) {
    expect(decode({ terminalFontFamily, terminalFontSize: 14 })).toMatchObject({
      terminalFontFamily,
      terminalFontSize: 14,
    });
  }
});
