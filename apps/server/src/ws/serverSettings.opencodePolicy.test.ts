import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "@bigbud/contracts/core/settings.ts";
import {
  normalizeExistingOpencodeSettings,
  preserveOpencodeEnablePreference,
} from "./serverSettings.opencodePolicy.ts";
import {
  decodeSettingsFieldWise,
  stripDefaultServerSettings,
} from "./serverSettings.persistence.ts";

describe("OpenCode default adoption without inferred consent", () => {
  it("enables V2 only for fresh defaults, not an ambiguous existing file", () => {
    expect(DEFAULT_SERVER_SETTINGS.providers.opencodeV2.enabled).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.providers.opencode.enabled).toBe(false);
    for (const input of [
      {},
      { providers: { opencode: { enabled: true } } },
      { providers: { opencodeV2: { profileRoot: "/private" } } },
    ]) {
      const loaded = Schema.decodeUnknownSync(ServerSettings)(
        JSON.parse(normalizeExistingOpencodeSettings(JSON.stringify(input))),
      );
      expect(loaded.providers.opencodeV2.enabled).toBe(false);
      expect(loaded.providers.opencode.enabled).toBe(false);
    }
  });
  it.each([true, false])(
    "preserves explicit V2 %s despite a legacy disable and sparse round trips",
    (enabled) => {
      const input = {
        enableThinkingStreaming: false,
        textGenerationModelSelection: { provider: "claudeAgent", model: "chosen" },
        providers: {
          opencode: { enabled: false, binaryPath: "/v1", customModels: ["historical"] },
          opencodeV2: { enabled, profileRoot: "/private", binaryPath: "/v2" },
          codex: { enabled: false },
        },
      };
      const loaded = Schema.decodeUnknownSync(ServerSettings)(
        JSON.parse(normalizeExistingOpencodeSettings(JSON.stringify(input))),
      );
      const sparse = (stripDefaultServerSettings(loaded, DEFAULT_SERVER_SETTINGS) ?? {}) as Record<
        string,
        unknown
      >;
      preserveOpencodeEnablePreference(sparse, loaded.providers.opencodeV2.enabled);
      const reloaded = Schema.decodeUnknownSync(ServerSettings)(
        JSON.parse(normalizeExistingOpencodeSettings(JSON.stringify(sparse))),
      );
      expect(reloaded).toEqual(loaded);
      expect(reloaded.providers.opencodeV2.enabled).toBe(enabled);
      expect(reloaded.providers.opencode.customModels).toEqual(["historical"]);
      expect(reloaded.providers.codex.enabled).toBe(false);
      expect(reloaded.textGenerationModelSelection).toEqual(input.textGenerationModelSelection);
    },
  );
  it("tolerant decode applies the same policy without losing unrelated valid fields", () => {
    const loaded = decodeSettingsFieldWise(
      JSON.stringify({
        defaultChatCwd: 42,
        enableThinkingStreaming: false,
        providers: { opencode: { binaryPath: "/historical" } },
      }),
    );
    expect(loaded?.providers.opencodeV2.enabled).toBe(false);
    expect(loaded?.providers.opencode.binaryPath).toBe("/historical");
    expect(loaded?.enableThinkingStreaming).toBe(false);
  });

  it.each([
    [{ enabled: false, binaryPath: 42 }, false],
    [{ binaryPath: 42 }, false],
    [{ enabled: true, binaryPath: 42 }, true],
    [{ enabled: "true", profileRoot: 42 }, false],
    [{ enabled: false, connectionMode: "invalid" }, false],
    [null, false],
    [42, false],
  ])("retains conservative enable intent despite malformed V2 settings %j", (entry, enabled) => {
    const loaded = decodeSettingsFieldWise(
      JSON.stringify({
        providers: { opencodeV2: entry, codex: { enabled: false } },
        enableThinkingStreaming: false,
      }),
    );
    expect(loaded?.providers.opencodeV2.enabled).toBe(enabled);
    expect(loaded?.providers.opencode.enabled).toBe(false);
    expect(loaded?.providers.codex.enabled).toBe(false);
    expect(loaded?.enableThinkingStreaming).toBe(false);
  });
});
