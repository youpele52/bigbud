import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";

describe("search settings", () => {
  it("turns both search toggles on and keeps File Access (the gate) at none by default", () => {
    expect(DEFAULT_SERVER_SETTINGS.search).toEqual({
      thisComputer: true,
      connectedRemoteBackends: true,
      fileAccessLevel: "none",
      hasSeenThisComputerHint: false,
    });
    // Older settings files without the section decode with the same defaults.
    expect(
      Schema.decodeUnknownSync(ServerSettings)({ search: { thisComputer: false } }).search,
    ).toEqual({ ...DEFAULT_SERVER_SETTINGS.search, thisComputer: false });
  });

  it("accepts partial patches and rejects unknown File Access levels", () => {
    expect(
      Schema.decodeUnknownSync(ServerSettingsPatch)({ search: { thisComputer: true } }),
    ).toEqual({ search: { thisComputer: true } });
    expect(() =>
      Schema.decodeUnknownSync(ServerSettingsPatch)({ search: { fileAccessLevel: "everything" } }),
    ).toThrow();
  });
});
