import { describe, expect, it } from "vitest";

import { getProviderCapabilities, makeProviderCapabilitiesResolver } from "./providerCapabilities";

describe("provider capabilities", () => {
  it("keeps core capabilities available without optional registrations", () => {
    expect(getProviderCapabilities("codex")).toMatchObject({
      supportsRemoteProviderRuntime: true,
      supportsLocalRuntimeRemoteWorkspace: true,
    });
    expect(() => getProviderCapabilities("cliProxy")).toThrow(
      "Provider capabilities are not registered for 'cliProxy'.",
    );
  });

  it("resolves optional provider capabilities from registration data", () => {
    const capabilities = {
      supportsRemoteProviderRuntime: false,
      supportsLocalRuntimeRemoteWorkspace: true,
      toolInjectionMode: "mcp",
      needsBuiltinsDisabled: true,
    } as const;
    const resolve = makeProviderCapabilitiesResolver([{ provider: "cliProxy", capabilities }]);

    expect(resolve("cliProxy")).toEqual(capabilities);
    expect(resolve("codex")).toEqual(getProviderCapabilities("codex"));
  });
});
