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
  it("keeps an older CLIProxyAPI selectable when an update is recommended", () => {
    const snapshot = provider({
      status: "ready",
      auth: { status: "authenticated" },
      message: undefined,
      cliProxyVersion: {
        recommendedVersion: "8.0.51",
        runtimeVersion: "8.0.30",
        installedVersion: "8.0.30",
        installation: "homebrew",
        updateSource: "runtime",
      },
    });
    expect(
      getProviderModelAvailability({ providers: [snapshot], provider: snapshot, modelCount: 1 }),
    ).toEqual({ loading: false, unavailable: false, unavailableMessage: undefined });
  });

  it("shows loading during the initial V2 native/catalog probe", () => {
    const snapshot = provider({ provider: "opencodeV2", initialProbeComplete: false });
    expect(
      getProviderModelAvailability({ providers: [snapshot], provider: snapshot, modelCount: 0 })
        .loading,
    ).toBe(true);
  });

  it("keeps a cached V2 catalog browseable for setup after native readiness failure", () => {
    const snapshot = provider({
      provider: "opencodeV2",
      installed: false,
      message: "Refresh failed; no fallback was attempted.",
    });
    expect(
      getProviderModelAvailability({ providers: [snapshot], provider: snapshot, modelCount: 1 }),
    ).toMatchObject({ unavailable: false, unavailableMessage: snapshot.message });
    const disabled = { ...snapshot, enabled: false };
    expect(
      getProviderModelAvailability({ providers: [disabled], provider: disabled, modelCount: 1 })
        .unavailable,
    ).toBe(true);
  });

  it("does not make unavailable V1/native providers browseable because V2 has full-catalog browsing", () => {
    const snapshot = provider({ provider: "opencode", installed: false });
    expect(
      getProviderModelAvailability({ providers: [snapshot], provider: snapshot, modelCount: 1 })
        .unavailable,
    ).toBe(true);
  });
  it("shows V2 configuration failures instead of claiming the executable is missing", () => {
    const snapshot = provider({
      provider: "opencodeV2",
      installed: false,
      message: "V2 requires absolute binary and dedicated profile paths in Providers settings.",
    });
    expect(
      getProviderModelAvailability({ providers: [snapshot], provider: snapshot, modelCount: 0 }),
    ).toMatchObject({ unavailable: true, unavailableMessage: snapshot.message });
  });

  it("preserves the missing-installation message for other providers", () => {
    const snapshot = provider({ provider: "opencode", installed: false });
    expect(
      getProviderModelAvailability({ providers: [snapshot], provider: snapshot, modelCount: 0 }),
    ).toMatchObject({ unavailable: true, unavailableMessage: "Provider is not installed" });
  });

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

  it("explains unsupported providers for remote workspaces", () => {
    const remoteProvider = provider({
      provider: "cursor",
      status: "ready",
      supportsLocalRuntimeRemoteWorkspace: false,
    });
    expect(
      getProviderModelAvailability({
        providers: [remoteProvider],
        provider: remoteProvider,
        modelCount: 1,
        workspaceExecutionTargetId: "ssh:devbox",
      }),
    ).toMatchObject({
      unavailable: true,
      unavailableMessage: "Provider does not support a remote workspace with a local runtime",
    });
  });

  it("keeps missing or unknown capability metadata selectable", () => {
    const snapshot = provider({ provider: "cursor", status: "ready" });
    expect(
      getProviderModelAvailability({
        providers: [snapshot],
        provider: snapshot,
        modelCount: 1,
        workspaceExecutionTargetId: "ssh:devbox",
      }).unavailable,
    ).toBe(false);
    expect(
      getProviderModelAvailability({
        providers: [snapshot],
        provider: snapshot,
        modelCount: 1,
        workspaceExecutionTargetId: "local",
      }).unavailable,
    ).toBe(false);
  });

  it("keeps supported providers selectable for remote workspaces", () => {
    const snapshot = provider({
      provider: "pi",
      status: "ready",
      supportsLocalRuntimeRemoteWorkspace: true,
    });
    expect(
      getProviderModelAvailability({
        providers: [snapshot],
        provider: snapshot,
        modelCount: 1,
        workspaceExecutionTargetId: "ssh:devbox",
      }).unavailable,
    ).toBe(false);
  });

  it("shows the real health reason for a capable provider on a remote workspace", () => {
    const snapshot = provider({
      provider: "opencodeV2",
      message: "No native models are available.",
      supportsLocalRuntimeRemoteWorkspace: true,
    });
    expect(
      getProviderModelAvailability({
        providers: [snapshot],
        provider: snapshot,
        modelCount: 0,
        workspaceExecutionTargetId: "ssh:devbox",
      }),
    ).toMatchObject({ unavailable: true, unavailableMessage: "No native models are available." });
  });

  it("applies local health rules on remote workspaces for unverified sign-in", () => {
    const snapshot = provider({
      provider: "devin",
      status: "ready",
      auth: { status: "unknown" },
      message: undefined,
      supportsLocalRuntimeRemoteWorkspace: true,
    });
    for (const workspaceExecutionTargetId of ["ssh:devbox", "local"]) {
      expect(
        getProviderModelAvailability({
          providers: [snapshot],
          provider: snapshot,
          modelCount: 1,
          workspaceExecutionTargetId,
        }),
      ).toEqual({ loading: false, unavailable: false, unavailableMessage: undefined });
    }
  });
});
