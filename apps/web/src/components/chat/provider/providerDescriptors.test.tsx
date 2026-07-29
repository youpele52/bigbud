import { PROVIDER_DISPLAY_NAMES, PROVIDER_KINDS, type ServerProvider } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  PROVIDER_DESCRIPTORS,
  getProviderDescriptor,
  providerSupportsSubProviderID,
} from "./providerDescriptors";

function snapshot(
  input: Partial<ServerProvider> & Pick<ServerProvider, "provider">,
): ServerProvider {
  return {
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-28T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...input,
  };
}

describe("provider descriptors", () => {
  it("covers every provider exactly once in contract order", () => {
    expect(PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.provider)).toEqual(PROVIDER_KINDS);
    expect(new Set(PROVIDER_DESCRIPTORS.map((descriptor) => descriptor.provider)).size).toBe(
      PROVIDER_KINDS.length,
    );
    for (const descriptor of PROVIDER_DESCRIPTORS) {
      expect(descriptor.label).toBe(PROVIDER_DISPLAY_NAMES[descriptor.provider]);
      expect(descriptor.icon).toBeTypeOf("function");
    }
  });

  it("keeps CLIProxy visibility independent from native Claude", () => {
    const cliProxy = getProviderDescriptor("cliProxy");
    expect(
      cliProxy.isVisible([
        snapshot({ provider: "cliProxy" }),
        snapshot({ provider: "claudeAgent", enabled: false, installed: false }),
      ]),
    ).toBe(true);
    expect(cliProxy.isVisible([snapshot({ provider: "cliProxy", installed: false })])).toBe(false);
    expect(cliProxy.customModels).toBeNull();
    expect(cliProxy.catalogAuthoritative).toBe(true);
    expect(cliProxy.traitsEnabled).toBe(false);
    expect(cliProxy.settings.setupUrl).toBe(
      "https://help.router-for.me/introduction/quick-start.html",
    );
  });

  it("centralizes sub-provider support", () => {
    expect(providerSupportsSubProviderID("opencode")).toBe(true);
    expect(providerSupportsSubProviderID("kilocode")).toBe(true);
    expect(providerSupportsSubProviderID("pi")).toBe(true);
    expect(providerSupportsSubProviderID("cliProxy")).toBe(false);
  });
});
