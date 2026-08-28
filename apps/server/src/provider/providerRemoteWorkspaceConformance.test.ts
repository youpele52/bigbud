import { PROVIDER_KINDS } from "@bigbud/contracts/constants/provider.constant.ts";
import { describe, expect, it } from "vitest";

import { makeProviderCapabilitiesResolver } from "./providerCapabilities.ts";
import { CLIPROXY_PROVIDER_CAPABILITIES } from "./Layers/CliProxy/Composition.ts";
import {
  getProviderRemoteWorkspaceConformance,
  providerAdvertisesRemoteWorkspaceSupport,
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
      ).toBe(false);
    }
    expect(
      isUnsupportedProviderLocalRuntimeRemoteWorkspace({
        provider: "cursor",
        providerRuntimeExecutionTargetId: "ssh:devbox",
        workspaceExecutionTargetId: "ssh:devbox",
      }),
    ).toBe(false);
  });

  for (const provider of ["cursor", "cliProxy", "claudeAgent", "pi", "devin", "copilot"] as const) {
    it.each([
      ["probe pending", { initialProbeComplete: false }],
      ["missing binary", { installed: false }],
      ["missing credentials", { auth: { status: "unauthenticated" as const } }],
      ["unverified credentials", { auth: { status: "unknown" as const } }],
      ["disabled", { enabled: false }],
      ["provider error", { status: "error" as const }],
    ])(`${provider} does not advertise support while %s`, (_label, override) => {
      expect(
        providerAdvertisesRemoteWorkspaceSupport({
          provider,
          enabled: true,
          installed: true,
          initialProbeComplete: true,
          status: "ready",
          auth: { status: "authenticated" },
          ...override,
        }),
      ).toBe(false);
    });
  }

  it.each(["cursor", "cliProxy", "claudeAgent", "pi", "devin", "copilot"] as const)(
    "advertises %s support after binary and credentials are verified",
    (provider) => {
      expect(
        providerAdvertisesRemoteWorkspaceSupport({
          provider,
          enabled: true,
          installed: true,
          initialProbeComplete: true,
          status: "ready",
          auth: { status: "authenticated" },
        }),
      ).toBe(true);
    },
  );
});
