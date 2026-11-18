import { describe, expect, it, vi } from "vitest";

// Module-resolution stubs: every optional provider SDK import throws, as on a backend graph
// that does not ship it. Bootstrap must not touch them; only first use may fail, typed.
// Copilot loads its CommonJS closure through `createRequire`, so resolution is stubbed there too.
vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  const createRequire = (from: string | URL) => {
    const real = actual.createRequire(from);
    const stubbed = ((id: string) => {
      if (id === "@github/copilot-sdk") throw new Error("absent: @github/copilot-sdk");
      return real(id);
    }) as NodeJS.Require;
    return Object.assign(stubbed, { resolve: real.resolve, cache: real.cache });
  };
  return { ...actual, createRequire, default: { ...actual, createRequire } };
});
vi.mock("@github/copilot-sdk", () => {
  throw new Error("absent: @github/copilot-sdk");
});
vi.mock("@muse-code/sdk", () => {
  throw new Error("absent: @muse-code/sdk");
});
vi.mock("@opencode/client", () => {
  throw new Error("absent: @opencode/client");
});
vi.mock("@opencode/client/service", () => {
  throw new Error("absent: @opencode/client/service");
});
vi.mock("@earendil-works/pi-coding-agent", () => {
  throw new Error("absent: @earendil-works/pi-coding-agent");
});

import { OptionalSdkUnavailableError } from "./optionalSdk.ts";

describe("lazy optional provider SDKs", () => {
  it("unselected_absent_sdk_does_not_break_bootstrap", { timeout: 120_000 }, async () => {
    // The whole server composition, including the adapter registry and optional composition.
    const server = await import("../server.ts");
    const registry = await import("./Layers/ProviderAdapterRegistry.ts");
    const optional = await import("./Layers/OptionalProviderComposition.ts");
    expect(server.makeServerLayer).toBeDefined();
    expect(registry.ProviderAdapterRegistryLive).toBeDefined();
    expect(optional.OptionalProviderCompositionLive).toBeDefined();

    // First use reports which SDK is missing instead of crashing at import time.
    const { loadCopilotSdk } = await import("./Layers/Copilot/copilotSdk.lazy.ts");
    await expect(loadCopilotSdk()).rejects.toBeInstanceOf(OptionalSdkUnavailableError);
    await expect(loadCopilotSdk()).rejects.toThrow("@github/copilot-sdk");
    const { museSdk } = await import("./Layers/Muse/Client.lifecycle.ts");
    await expect(museSdk.load()).rejects.toThrow("@muse-code/sdk");
    const { opencodeV2Sdk } = await import("./Layers/OpencodeV2/Client.sdk.ts");
    expect(() => opencodeV2Sdk()).toThrow(OptionalSdkUnavailableError);
    const { makeV2Client } = await import("./Layers/OpencodeV2/Client.ts");
    expect(() => makeV2Client({ endpoint: "http://127.0.0.1:1" })).toThrow("@opencode/client");
    const { resolvePiInvocation } = await import("./Layers/Pi/Cli.ts");
    expect(resolvePiInvocation("pi").command).toBeTruthy();
  });
});
