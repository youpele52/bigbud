import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";

describe("Ìtútù idle settings", () => {
  it("default to off, 10 minutes, and Done", () => {
    expect(DEFAULT_SERVER_SETTINGS).toMatchObject({
      itutuIdleCleanupEnabled: false,
      itutuIdleTimeoutMinutes: 10,
      itutuIdleDestination: "done",
    });
  });

  it("accept whole minutes from 1 and only Done or Later", () => {
    const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
    expect(decodePatch({ itutuIdleTimeoutMinutes: 1, itutuIdleDestination: "later" })).toEqual({
      itutuIdleTimeoutMinutes: 1,
      itutuIdleDestination: "later",
    });
    for (const patch of [
      { itutuIdleTimeoutMinutes: 0 },
      { itutuIdleTimeoutMinutes: 1.5 },
      { itutuIdleTimeoutMinutes: 7 * 24 * 60 + 1 },
      { itutuIdleDestination: "needs-you" },
      { itutuIdleDestination: "present" },
    ]) {
      expect(() => decodePatch(patch), JSON.stringify(patch)).toThrow();
    }
    expect(Schema.decodeUnknownSync(ServerSettings)({}).itutuIdleTimeoutMinutes).toBe(10);
  });
});
