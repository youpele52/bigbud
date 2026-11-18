import { PROVIDER_KINDS } from "@bigbud/contracts/constants/provider.constant.ts";
import { describe, expect, it } from "vitest";

import { makeProviderCapabilitiesResolver } from "./providerCapabilities.ts";
import { CLIPROXY_PROVIDER_CAPABILITIES } from "./Layers/CliProxy/Composition.ts";
import { MUSE_PROVIDER_CAPABILITIES } from "./Layers/Muse/Composition.ts";
import { V2_APPLICATION_CAPABILITIES } from "./Layers/OpencodeV2/Application.capabilities.ts";
import {
  getProviderRemoteWorkspaceConformance,
  resolveSnapshotRemoteWorkspaceSupport,
} from "./providerRemoteWorkspaceConformance.ts";
import { isUnsupportedProviderLocalRuntimeRemoteWorkspace } from "./providerExecutionTargets.ts";

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
      { provider: "opencodeV2", capabilities: V2_APPLICATION_CAPABILITIES },
      { provider: "muse", capabilities: MUSE_PROVIDER_CAPABILITIES },
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

  it("rejects only unsupported providers for local runtime and remote workspace", () => {
    for (const provider of PROVIDER_KINDS) {
      expect(
        isUnsupportedProviderLocalRuntimeRemoteWorkspace({
          provider,
          providerRuntimeExecutionTargetId: "local",
          workspaceExecutionTargetId: "ssh:devbox",
        }),
      ).toBe(!getProviderRemoteWorkspaceConformance(provider).supportsLocalRuntimeRemoteWorkspace);
    }
    expect(
      isUnsupportedProviderLocalRuntimeRemoteWorkspace({
        provider: "cursor",
        providerRuntimeExecutionTargetId: "ssh:devbox",
        workspaceExecutionTargetId: "ssh:devbox",
      }),
    ).toBe(false);
  });

  it.each(["cursor", "cliProxy", "claudeAgent", "pi", "devin", "copilot", "opencodeV2"] as const)(
    "publishes %s capability independently of provider health",
    (provider) => {
      expect(resolveSnapshotRemoteWorkspaceSupport({ provider })).toBe(true);
      expect(
        resolveSnapshotRemoteWorkspaceSupport({
          provider,
          supportsLocalRuntimeRemoteWorkspace: true,
        }),
      ).toBe(true);
    },
  );

  it("honors an explicit snapshot opt-out", () => {
    expect(
      resolveSnapshotRemoteWorkspaceSupport({
        provider: "opencodeV2",
        supportsLocalRuntimeRemoteWorkspace: false,
      }),
    ).toBe(false);
  });

  it("never lets a snapshot claim support for an unsupported backend", () => {
    expect(
      resolveSnapshotRemoteWorkspaceSupport({
        provider: "muse",
        supportsLocalRuntimeRemoteWorkspace: true,
      }),
    ).toBe(false);
  });
});
