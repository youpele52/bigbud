import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PROVIDER_KINDS } from "../constants/provider.constant";
import { ServerSettings } from "../core/settings";
import { ModelSelection, PersistedModelSelection } from "./orchestration.provider";

const selection = {
  provider: "kilocode",
  model: "legacy-model",
  options: { reasoningEffort: "custom-high" },
  subProviderID: "openrouter",
};

describe("removed KiloCode provider", () => {
  it("preserves saved selections losslessly without allowing new routing", () => {
    const persisted = Schema.decodeUnknownSync(PersistedModelSelection)(selection);
    expect(persisted).toEqual(selection);
    expect(Schema.encodeSync(PersistedModelSelection)(persisted)).toEqual(selection);
    expect(() => Schema.decodeUnknownSync(ModelSelection)(selection)).toThrow();
    expect(PROVIDER_KINDS).not.toContain("kilocode");
  });

  it("ignores obsolete provider settings while preserving current settings", () => {
    const settings = Schema.decodeUnknownSync(ServerSettings)({
      hiddenComposerProviders: ["kilocode", "pi"],
      providers: {
        kilocode: { enabled: true, binaryPath: "/old/kilo" },
        codex: { binaryPath: "/current/codex" },
      },
    });
    expect(settings.hiddenComposerProviders).toEqual(["pi"]);
    expect(settings.providers).not.toHaveProperty("kilocode");
    expect(settings.providers.codex.binaryPath).toBe("/current/codex");
  });
});
