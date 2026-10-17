import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_PROVIDER_KIND } from "../constants/provider.constant";
import { ServerSettings, DEFAULT_SERVER_SETTINGS } from "./settings";
import { ServerSettingsPatch } from "./settings.serverPatch";
import { ModelSelection } from "../orchestration/orchestration.provider";

describe("independent OpenCode settings and identity", () => {
  it("fresh schema defaults enable V2 without altering paths or global default", () => {
    const decoded = Schema.decodeUnknownSync(ServerSettings)({
      providers: { opencode: { binaryPath: "/v1" }, kilocode: { binaryPath: "/kilo" } },
    });
    expect(decoded.providers.opencodeV2).toEqual({
      enabled: true,
      binaryPath: "",
      profileRoot: "",
    });
    expect(decoded.providers.opencode.binaryPath).toBe("/v1");
    expect(decoded.providers.opencode.enabled).toBe(false);
    expect(decoded.providers.kilocode.binaryPath).toBe("/kilo");
    expect(DEFAULT_PROVIDER_KIND).toBe("codex");
  });
  it("V2 settings and provider/model/variant identities encode independently", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        opencodeV2: { enabled: true, binaryPath: "/v2", profileRoot: "/isolated" },
      },
    };
    const decoded = Schema.decodeUnknownSync(ServerSettings)(
      Schema.encodeSync(ServerSettings)(settings),
    );
    expect(decoded.providers.opencodeV2).toEqual(settings.providers.opencodeV2);
    for (const provider of ["opencode", "opencodeV2", "kilocode"] as const) {
      const selection = {
        provider,
        model: "native-model",
        subProviderID: "native-provider",
        ...(provider === "opencodeV2" ? { options: { variant: "high" } } : {}),
      };
      expect(Schema.decodeUnknownSync(ModelSelection)(selection)).toEqual(selection);
    }
  });
  it("patches V2 without accepting secrets or aliasing V1 model options", () => {
    expect(
      Schema.decodeUnknownSync(ServerSettingsPatch)({
        providers: { opencodeV2: { binaryPath: "/v2", profileRoot: "/isolated" } },
      }),
    ).toEqual({ providers: { opencodeV2: { binaryPath: "/v2", profileRoot: "/isolated" } } });
    expect(
      Schema.decodeUnknownSync(ModelSelection)({
        provider: "opencodeV2",
        model: "fixture",
        options: { reasoningEffort: "high" },
      }),
    ).toEqual({ provider: "opencodeV2", model: "fixture", options: {} });
  });
});
