import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";
import { MuseModelSelection } from "../orchestration/orchestration.provider";

describe("Muse settings", () => {
  it("defaults disabled with the native binary name and no credential fields", () => {
    expect(DEFAULT_SERVER_SETTINGS.providers.muse).toEqual({ enabled: false, binaryPath: "muse" });
    const decoded = Schema.decodeUnknownSync(ServerSettings)({});
    expect(decoded.providers.muse.enabled).toBe(false);
  });

  it("round-trips an explicit enable and binary path through the patch schema", () => {
    const patch = Schema.decodeUnknownSync(ServerSettingsPatch)({
      providers: { muse: { enabled: true, binaryPath: "/opt/muse" } },
    });
    expect(patch.providers?.muse).toEqual({ enabled: true, binaryPath: "/opt/muse" });
  });

  it("preserves Muse model selection sub-provider identity", () => {
    const selection = Schema.decodeUnknownSync(MuseModelSelection)({
      provider: "muse",
      model: "muse-spark-1.3",
      subProviderID: "meta",
      options: { reasoningEffort: "low" },
    });
    expect(selection).toEqual({
      provider: "muse",
      model: "muse-spark-1.3",
      subProviderID: "meta",
      options: { reasoningEffort: "low" },
    });
  });
});
