import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";

describe("Inyosira idle settings", () => {
  it("default to on: 10 minutes to Later, then 1 day to Done", () => {
    expect(DEFAULT_SERVER_SETTINGS).toMatchObject({
      inyosiraIdleCleanupEnabled: true,
      inyosiraIdleTimeoutMinutes: 10,
      inyosiraIdleDestination: "later",
      inyosiraOlderThreadsEnabled: true,
      inyosiraOlderThreadsDays: 1,
    });
  });

  it("accept idle timeouts from 10 minutes to 1 day and only Done or Later", () => {
    const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
    expect(
      decodePatch({ inyosiraIdleTimeoutMinutes: 10, inyosiraIdleDestination: "done" }),
    ).toEqual({
      inyosiraIdleTimeoutMinutes: 10,
      inyosiraIdleDestination: "done",
    });
    expect(decodePatch({ inyosiraIdleTimeoutMinutes: 24 * 60 })).toEqual({
      inyosiraIdleTimeoutMinutes: 24 * 60,
    });
    for (const patch of [
      { inyosiraIdleTimeoutMinutes: 9 },
      { inyosiraIdleTimeoutMinutes: 10.5 },
      { inyosiraIdleTimeoutMinutes: 24 * 60 + 1 },
      { inyosiraIdleDestination: "needs-you" },
      { inyosiraIdleDestination: "present" },
    ]) {
      expect(() => decodePatch(patch), JSON.stringify(patch)).toThrow();
    }
    expect(Schema.decodeUnknownSync(ServerSettings)({}).inyosiraIdleTimeoutMinutes).toBe(10);
  });

  it("accept older-thread ages in whole days from 1 to 30", () => {
    const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
    expect(
      decodePatch({ inyosiraOlderThreadsEnabled: false, inyosiraOlderThreadsDays: 30 }),
    ).toEqual({
      inyosiraOlderThreadsEnabled: false,
      inyosiraOlderThreadsDays: 30,
    });
    for (const patch of [
      { inyosiraOlderThreadsDays: 0 },
      { inyosiraOlderThreadsDays: 1.5 },
      { inyosiraOlderThreadsDays: 31 },
    ]) {
      expect(() => decodePatch(patch), JSON.stringify(patch)).toThrow();
    }
    expect(Schema.decodeUnknownSync(ServerSettings)({}).inyosiraOlderThreadsDays).toBe(1);
  });
});
