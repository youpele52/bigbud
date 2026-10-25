import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS, type ServerProvider } from "@bigbud/contracts";
import { resolveTextGenByProbeStatus } from "./wsSettingsResolver.ts";

describe("resolveTextGenByProbeStatus", () => {
  it("never replaces a configured pair based on provider telemetry", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: { provider: "cliProxy" as const, model: "explicit-model" },
    };
    const probes = [
      { provider: "codex", status: "ready" },
    ] as unknown as ReadonlyArray<ServerProvider>;
    expect(resolveTextGenByProbeStatus(settings, probes)).toBe(settings);
  });
  it("does not invent a preference for a fresh install", () => {
    expect(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection).toBeNull();
    expect(resolveTextGenByProbeStatus(DEFAULT_SERVER_SETTINGS, [])).toBe(DEFAULT_SERVER_SETTINGS);
  });
});
