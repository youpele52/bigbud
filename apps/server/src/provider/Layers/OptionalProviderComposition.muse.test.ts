import { describe, expect, it } from "vitest";

import type { OptionalProviderRegistration } from "../ProviderRegistration.ts";
import { appendMuseRegistration } from "./OptionalProviderComposition.ts";
import { MUSE_PROVIDER_CAPABILITIES } from "./Muse/Composition.ts";

function fakeRegistration(provider: string): OptionalProviderRegistration {
  return {
    provider: provider as OptionalProviderRegistration["provider"],
    providerService: {} as OptionalProviderRegistration["providerService"],
    adapterService: {} as OptionalProviderRegistration["adapterService"],
    capabilities: MUSE_PROVIDER_CAPABILITIES,
  };
}

describe("Muse optional composition", () => {
  it("preserves existing CLIProxy and OpenCode v2 registrations", () => {
    const existing = [fakeRegistration("cliProxy"), fakeRegistration("opencodeV2")];
    const composed = appendMuseRegistration(existing, fakeRegistration("muse"));
    expect(composed.map((r) => r.provider)).toEqual(["cliProxy", "opencodeV2", "muse"]);
    expect(existing).toHaveLength(2);
  });

  it("rejects a duplicate Muse registration", () => {
    expect(() =>
      appendMuseRegistration([fakeRegistration("muse")], fakeRegistration("muse")),
    ).toThrow("already registered");
  });

  it("declares local-only MCP capabilities with persistent native history", () => {
    expect(MUSE_PROVIDER_CAPABILITIES.supportsRemoteProviderRuntime).toBe(false);
    expect(MUSE_PROVIDER_CAPABILITIES.supportsLocalRuntimeRemoteWorkspace).toBe(false);
    expect(MUSE_PROVIDER_CAPABILITIES.toolInjectionMode).toBe("mcp");
    expect(MUSE_PROVIDER_CAPABILITIES.sessionHistorySemantics).toBe("persistent");
    expect(MUSE_PROVIDER_CAPABILITIES.tokenUsageSemantics).toBe("unavailable");
  });
});
