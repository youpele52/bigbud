import { PROVIDER_KINDS } from "@bigbud/contracts/constants/provider.constant.ts";
import { describe, expect, it } from "vitest";

import { makeProviderCapabilitiesResolver } from "./providerCapabilities.ts";
import { CLIPROXY_PROVIDER_CAPABILITIES } from "./Layers/CliProxy/Composition.ts";
import { getProviderRemoteWorkspaceConformance } from "./providerRemoteWorkspaceConformance.ts";

describe("provider remote workspace conformance matrix", () => {
  it("has an authoritative result for every registered provider", () => {
    expect(PROVIDER_KINDS.map(getProviderRemoteWorkspaceConformance)).toHaveLength(
      PROVIDER_KINDS.length,
    );
    for (const provider of PROVIDER_KINDS) {
      const conformance = getProviderRemoteWorkspaceConformance(provider);
      expect(conformance.provider).toBe(provider);
      expect(conformance.reason.length).toBeGreaterThan(0);
    }
  });

  it("never claims a capability for an unsupported backend", () => {
    const resolveCapabilities = makeProviderCapabilitiesResolver([
      { provider: "cliProxy", capabilities: CLIPROXY_PROVIDER_CAPABILITIES },
    ]);
    for (const provider of PROVIDER_KINDS) {
      const conformance = getProviderRemoteWorkspaceConformance(provider);
      expect(conformance.supportsLocalRuntimeRemoteWorkspace).toBe(
        resolveCapabilities(provider).supportsLocalRuntimeRemoteWorkspace,
      );
      expect(conformance.backend === "unsupported").toBe(
        !conformance.supportsLocalRuntimeRemoteWorkspace,
      );
      if (conformance.supportsLocalRuntimeRemoteWorkspace) {
        expect(conformance.backend).toBe("agent-runtime");
      }
    }
  });
});
