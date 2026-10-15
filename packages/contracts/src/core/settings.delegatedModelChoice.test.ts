import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ClientSettingsSchema, DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";

describe("delegated model choice settings", () => {
  it("lets agents choose delegated models by default (OD4)", () => {
    expect(DEFAULT_SERVER_SETTINGS.delegatedThreadModelChoice).toBe("agent");
    expect(
      Schema.decodeUnknownSync(ServerSettingsPatch)({ delegatedThreadModelChoice: "parent" }),
    ).toEqual({ delegatedThreadModelChoice: "parent" });
    expect(() =>
      Schema.decodeUnknownSync(ServerSettingsPatch)({ delegatedThreadModelChoice: "any" }),
    ).toThrow();
  });

  it("keeps hidden composer providers on the server (OD1)", () => {
    expect(DEFAULT_SERVER_SETTINGS.hiddenComposerProviders).toEqual([]);
    expect(
      Schema.decodeUnknownSync(ServerSettings)({ hiddenComposerProviders: ["copilot"] })
        .hiddenComposerProviders,
    ).toEqual(["copilot"]);
    expect(
      Schema.decodeUnknownSync(ServerSettingsPatch)({ hiddenComposerProviders: ["pi"] }),
    ).toEqual({ hiddenComposerProviders: ["pi"] });
    expect("hiddenComposerProviders" in ClientSettingsSchema.fields).toBe(false);
  });
});
