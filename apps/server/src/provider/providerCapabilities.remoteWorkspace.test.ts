import { describe, expect, it } from "vitest";

import { CLIPROXY_PROVIDER_CAPABILITIES } from "./Layers/CliProxy/Composition.ts";
import { getProviderCapabilities } from "./providerCapabilities.ts";

describe("provider remote workspace capability declarations", () => {
  it.each(["cursor", "devin"] as const)(
    "declares %s support after its ACP workspace and tool bridge became remote-aware",
    (provider) => {
      expect(getProviderCapabilities(provider).supportsLocalRuntimeRemoteWorkspace).toBe(true);
    },
  );

  it.each(["claudeAgent", "copilot", "pi"] as const)(
    "retains %s support through the verified remote bridge",
    (provider) => {
      expect(getProviderCapabilities(provider).supportsLocalRuntimeRemoteWorkspace).toBe(true);
    },
  );

  it("retains CLI proxy support through its optional-provider registration", () => {
    expect(CLIPROXY_PROVIDER_CAPABILITIES.supportsLocalRuntimeRemoteWorkspace).toBe(true);
  });
});
