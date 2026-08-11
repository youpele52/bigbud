import type { ProviderKind, ServerProvider } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { resolveStartupSelectableProvider } from "./provider.models";

function provider(kind: ProviderKind, overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    provider: kind,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-11T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("resolveStartupSelectableProvider", () => {
  it("uses a ready provider while the selected provider is still being checked at launch", () => {
    const providers = [
      provider("opencode", {
        installed: false,
        status: "warning",
        initialProbeComplete: false,
      }),
      provider("claudeAgent"),
    ];

    expect(resolveStartupSelectableProvider(providers, "opencode")).toBe("claudeAgent");
  });

  it("uses a ready provider when launch recovery confirms the selected provider is unavailable", () => {
    const providers = [
      provider("opencode", {
        installed: false,
        status: "error",
        recovery: {
          operationId: "startup-1",
          generation: 1,
          attempt: 2,
          maxAttempts: 5,
          trigger: "startup",
          status: "retrying",
        },
        failure: { classification: "user-action-required", reason: "command-not-found" },
      }),
      provider("claudeAgent"),
    ];

    expect(resolveStartupSelectableProvider(providers, "opencode")).toBe("claudeAgent");
  });

  it("preserves the explicit provider outside launch recovery", () => {
    const providers = [provider("opencode", { status: "error" }), provider("claudeAgent")];

    expect(resolveStartupSelectableProvider(providers, "opencode")).toBe("opencode");
  });
});
