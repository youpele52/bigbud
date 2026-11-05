import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { ServerSettings } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";

describe("retired terminal backend settings", () => {
  it("loads older settings without restoring the removed backend preference", () => {
    const settings = Schema.decodeUnknownSync(ServerSettings)({
      enableAssistantStreaming: false,
      herdrTerminals: [{ executionTargetId: "local", enabled: true }],
    });
    expect(settings.enableAssistantStreaming).toBe(false);
    expect(Object.hasOwn(settings, "herdrTerminals")).toBe(false);
  });

  it("does not expose the retired backend through settings patches", () => {
    const patch = Schema.decodeUnknownSync(ServerSettingsPatch)({ herdrTerminals: [] });
    expect(patch).toEqual({});
  });
});
