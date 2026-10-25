import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerSettings } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";

describe("prompt suggestion settings", () => {
  it("default on, including for settings saved before they existed", () => {
    const settings = Schema.decodeUnknownSync(ServerSettings)({ enableAssistantStreaming: true });
    expect(settings.promptSuggestions).toBe(true);
    expect(settings.generatedPromptSuggestions).toBe(true);
  });

  it("can be turned off with a server patch", () => {
    expect(
      Schema.decodeUnknownSync(ServerSettingsPatch)({
        promptSuggestions: false,
        generatedPromptSuggestions: false,
      }),
    ).toEqual({ promptSuggestions: false, generatedPromptSuggestions: false });
  });
});
