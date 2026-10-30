import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";

describe("Ìtútù idle settings", () => {
  it("default to on: 10 minutes to Later, then 1 day to Done", () => {
    expect(DEFAULT_SERVER_SETTINGS).toMatchObject({
      itutuIdleCleanupEnabled: true,
      itutuIdleTimeoutMinutes: 10,
      itutuIdleDestination: "later",
      itutuOlderThreadsEnabled: true,
      itutuOlderThreadsDays: 1,
    });
  });

  it("accept idle timeouts from 10 minutes to 1 day and only Done or Later", () => {
    const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
    expect(decodePatch({ itutuIdleTimeoutMinutes: 10, itutuIdleDestination: "done" })).toEqual({
      itutuIdleTimeoutMinutes: 10,
      itutuIdleDestination: "done",
    });
    expect(decodePatch({ itutuIdleTimeoutMinutes: 24 * 60 })).toEqual({
      itutuIdleTimeoutMinutes: 24 * 60,
    });
    for (const patch of [
      { itutuIdleTimeoutMinutes: 9 },
      { itutuIdleTimeoutMinutes: 10.5 },
      { itutuIdleTimeoutMinutes: 24 * 60 + 1 },
      { itutuIdleDestination: "needs-you" },
      { itutuIdleDestination: "present" },
    ]) {
      expect(() => decodePatch(patch), JSON.stringify(patch)).toThrow();
    }
    expect(Schema.decodeUnknownSync(ServerSettings)({}).itutuIdleTimeoutMinutes).toBe(10);
  });

  it("accept older-thread ages in whole days from 1 to 30", () => {
    const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
    expect(decodePatch({ itutuOlderThreadsEnabled: false, itutuOlderThreadsDays: 30 })).toEqual({
      itutuOlderThreadsEnabled: false,
      itutuOlderThreadsDays: 30,
    });
    for (const patch of [
      { itutuOlderThreadsDays: 0 },
      { itutuOlderThreadsDays: 1.5 },
      { itutuOlderThreadsDays: 31 },
    ]) {
      expect(() => decodePatch(patch), JSON.stringify(patch)).toThrow();
    }
    expect(Schema.decodeUnknownSync(ServerSettings)({}).itutuOlderThreadsDays).toBe(1);
  });
});
