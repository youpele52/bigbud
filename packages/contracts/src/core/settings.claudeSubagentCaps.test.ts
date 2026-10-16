import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerSettings } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("Claude subagent cap settings", () => {
  it("are unset by default, including for settings saved before the caps existed", () => {
    const settings = decodeSettings({ providers: { claudeAgent: { enabled: true } } });
    expect(settings.providers.claudeAgent.maxSubagentSpawnDepth).toBeNull();
    expect(settings.providers.claudeAgent.maxConcurrentSubagents).toBeNull();
  });

  it("accept positive caps and null (unset) in a server patch", () => {
    const patch = decodePatch({
      providers: { claudeAgent: { maxSubagentSpawnDepth: 2, maxConcurrentSubagents: null } },
    });
    expect(patch.providers?.claudeAgent).toEqual({
      maxSubagentSpawnDepth: 2,
      maxConcurrentSubagents: null,
    });
  });

  it("reject caps the Claude Code CLI would refuse", () => {
    for (const value of [0, -1, 1.5, 65]) {
      expect(() =>
        decodePatch({ providers: { claudeAgent: { maxSubagentSpawnDepth: value } } }),
      ).toThrow();
    }
  });
});
