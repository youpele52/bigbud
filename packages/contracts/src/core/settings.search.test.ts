import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";

describe("search settings", () => {
  it("keeps this computer off, remote search on and File Access at none by default", () => {
    expect(DEFAULT_SERVER_SETTINGS.search).toEqual({
      thisComputer: false,
      connectedRemoteBackends: true,
      fileAccessLevel: "none",
      hasSeenThisComputerHint: false,
    });
    // Older settings files without the section decode with the same defaults.
    expect(
      Schema.decodeUnknownSync(ServerSettings)({ search: { thisComputer: true } }).search,
    ).toEqual({ ...DEFAULT_SERVER_SETTINGS.search, thisComputer: true });
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
