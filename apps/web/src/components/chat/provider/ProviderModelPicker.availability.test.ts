import type { ServerProvider } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { getProviderModelAvailability } from "./ProviderModelPicker.models";

function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    provider: "cliProxy",
    enabled: true,
    installed: true,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    checkedAt: "2026-07-27T00:00:00.000Z",
    models: [],
    message: "CLIProxyAPI returned no Codex-compatible models.",
    ...overrides,
  } as ServerProvider;
}

describe("getProviderModelAvailability", () => {
  it("reports an empty warning snapshot as unavailable instead of loading", () => {
    expect(
      getProviderModelAvailability({
        providers: [provider()],
        provider: provider(),
        modelCount: 0,
      }),
    ).toEqual({
      loading: false,
      unavailable: true,
      unavailableMessage: "CLIProxyAPI returned no Codex-compatible models.",
    });
  });

  it("reports a missing snapshot as loading while provider data is unavailable", () => {
    expect(
      getProviderModelAvailability({ providers: undefined, provider: undefined, modelCount: 0 }),
    ).toEqual({ loading: true, unavailable: false, unavailableMessage: undefined });
  });

  it("allows a warning provider once it has models", () => {
    expect(
      getProviderModelAvailability({
        providers: [provider()],
        provider: provider(),
        modelCount: 1,
      }),
    ).toEqual({
      loading: false,
      unavailable: false,
      unavailableMessage: "CLIProxyAPI returned no Codex-compatible models.",
    });
  });
});
