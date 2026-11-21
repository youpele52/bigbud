import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";

describe("terminal lifecycle settings", () => {
  it("keeps terminals stopping at quit unless the user opts in", () => {
    expect(DEFAULT_SERVER_SETTINGS.terminalsKeepRunningAfterQuit).toBe(false);
    expect(Schema.decodeUnknownSync(ServerSettings)({}).terminalsKeepRunningAfterQuit).toBe(false);
    expect(
      Schema.decodeUnknownSync(ServerSettings)({ terminalsKeepRunningAfterQuit: true })
        .terminalsKeepRunningAfterQuit,
    ).toBe(true);
  });

  it("patches the server-owned switch and rejects non-boolean values", () => {
    const decode = Schema.decodeUnknownSync(ServerSettingsPatch);
    expect(decode({ terminalsKeepRunningAfterQuit: true })).toEqual({
      terminalsKeepRunningAfterQuit: true,
    });
    expect(decode({})).toEqual({});
    expect(() => decode({ terminalsKeepRunningAfterQuit: "yes" })).toThrow();
  });
});
