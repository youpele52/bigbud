import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import { ServerSettings, DEFAULT_SERVER_SETTINGS } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";

describe("Computer Use delivery preference", () => {
  it("defaults new and existing settings without a preference to background", () => {
    expect(DEFAULT_SERVER_SETTINGS.computerUseDeliveryMode).toBe("background");
    expect(
      Schema.decodeSync(ServerSettings)({ computerUseEnabled: true }).computerUseDeliveryMode,
    ).toBe("background");
  });

  it.each(["background", "foreground"])("accepts and preserves %s", (mode) => {
    const patch = Schema.decodeUnknownSync(ServerSettingsPatch)({ computerUseDeliveryMode: mode });
    expect(Schema.decodeUnknownSync(ServerSettings)(patch).computerUseDeliveryMode).toBe(mode);
  });

  it("rejects unknown modes rather than implicitly enabling foreground", () => {
    expect(() =>
      Schema.decodeUnknownSync(ServerSettingsPatch)({ computerUseDeliveryMode: "automatic" }),
    ).toThrow();
  });
});
