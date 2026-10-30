import { describe, expect, it } from "vitest";

import { decodeSettingsFieldWise } from "./serverSettings.persistence.ts";

describe("Ìtútù idle settings persistence", () => {
  it("resets a saved timeout below the new 10-minute minimum and keeps the other fields", () => {
    const decoded = decodeSettingsFieldWise(
      JSON.stringify({
        itutuIdleCleanupEnabled: false,
        itutuIdleTimeoutMinutes: 5,
        itutuIdleDestination: "done",
      }),
    );
    expect(decoded).toMatchObject({
      itutuIdleCleanupEnabled: false,
      itutuIdleTimeoutMinutes: 10,
      itutuIdleDestination: "done",
      itutuOlderThreadsEnabled: true,
      itutuOlderThreadsDays: 1,
    });
  });
});
