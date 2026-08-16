import type { ServerProvider } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  getComposerProviderFallback,
  getVisibleComposerProviders,
  isComposerProviderVisible,
} from "./composerVisibility.models";

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    provider: "codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", type: "chatgpt" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    ...overrides,
  } as ServerProvider;
}

describe("composer provider visibility", () => {
  it("keeps providers visible unless they are explicitly hidden", () => {
    expect(isComposerProviderVisible("codex", [])).toBe(true);
    expect(isComposerProviderVisible("codex", ["codex"])).toBe(false);
    expect(getVisibleComposerProviders(["codex"])).not.toContain("codex");
  });

  it("falls back from hidden providers by ready, enabled, then descriptor order", () => {
    expect(
      getComposerProviderFallback(
        [
          provider({ provider: "claudeAgent", enabled: true, status: "warning" }),
          provider({ provider: "copilot", enabled: true, status: "ready" }),
        ],
        ["codex"],
      ),
    ).toBe("copilot");
    expect(
      getComposerProviderFallback(
        [provider({ provider: "claudeAgent", enabled: true, status: "warning" })],
        ["codex"],
      ),
    ).toBe("claudeAgent");
    expect(getComposerProviderFallback([], ["codex"])).toBe("claudeAgent");
  });

  it("has no fallback when every provider is hidden", () => {
    expect(getComposerProviderFallback([], getVisibleComposerProviders([]))).toBeNull();
  });
});
