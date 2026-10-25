import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { ServerSettings, DEFAULT_SERVER_SETTINGS } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";
import { GreetingName } from "./settings.greeting";

describe("greeting name settings", () => {
  it("defaults to an intentionally empty shared server preference", () => {
    expect(Schema.decodeSync(ServerSettings)({}).greetingName).toBe("");
    expect(DEFAULT_SERVER_SETTINGS.greetingName).toBe("");
    expect(Schema.decodeSync(ServerSettingsPatch)({})).toEqual({});
  });

  it.each(["Youpele", "Éloïse", "小雨", "مريم", "🛠️ Builder", "<b>nickname</b>"])(
    "trims outer whitespace and preserves Unicode/plain text: %s",
    (name) => {
      expect(Schema.decodeSync(GreetingName)(`  ${name} \n`)).toBe(name);
      expect(Schema.decodeSync(ServerSettingsPatch)({ greetingName: ` ${name} ` })).toEqual({
        greetingName: name,
      });
    },
  );

  it("accepts clearing and enforces the same 64-character limit on storage and patches", () => {
    expect(Schema.decodeSync(GreetingName)("   ")).toBe("");
    expect(Schema.decodeSync(GreetingName)("a".repeat(64))).toHaveLength(64);
    expect(() => Schema.decodeSync(GreetingName)("a".repeat(65))).toThrow();
    expect(() => Schema.decodeSync(ServerSettings)({ greetingName: "a".repeat(65) })).toThrow();
    expect(() =>
      Schema.decodeSync(ServerSettingsPatch)({ greetingName: "a".repeat(65) }),
    ).toThrow();
  });
});
