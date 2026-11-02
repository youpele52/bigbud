import { describe, expect, it } from "vitest";

import { decodeSettingsFieldWise } from "./serverSettings.persistence.ts";

describe("Inyosira idle settings persistence", () => {
  it("resets a saved timeout below the new 10-minute minimum and keeps the other fields", () => {
    const decoded = decodeSettingsFieldWise(
      JSON.stringify({
        inyosiraIdleCleanupEnabled: false,
        inyosiraIdleTimeoutMinutes: 5,
        inyosiraIdleDestination: "done",
      }),
    );
    expect(decoded).toMatchObject({
      inyosiraIdleCleanupEnabled: false,
      inyosiraIdleTimeoutMinutes: 10,
      inyosiraIdleDestination: "done",
      inyosiraOlderThreadsEnabled: true,
      inyosiraOlderThreadsDays: 1,
    });
  });
});
