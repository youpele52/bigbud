import { describe, expect, it } from "vitest";

import {
  providerSwitchTargetLabel,
  resolveInheritedFullAccessDowngrade,
  resolveProviderSwitchRuntimeMode,
} from "./chat-view-provider-switch.hooks";

describe("providerSwitchTargetLabel", () => {
  it("keeps CLIProxyAPI distinct from Codex", () => {
    expect(providerSwitchTargetLabel("cliProxy")).toBe("CLIProxyAPI");
  });
});

describe("resolveProviderSwitchRuntimeMode", () => {
  it("moves an unsupported mode to the provider's first qualified mode", () => {
    expect(
      resolveProviderSwitchRuntimeMode({
        supportedRuntimeModes: ["auto-accept-edits"],
        currentRuntimeMode: "full-access",
      }),
    ).toBe("auto-accept-edits");
    expect(
      resolveProviderSwitchRuntimeMode({
        supportedRuntimeModes: ["auto-accept-edits"],
        currentRuntimeMode: "approval-required",
      }),
    ).toBe("auto-accept-edits");
  });

  it("keeps a qualified or unrestricted mode unchanged", () => {
    expect(
      resolveProviderSwitchRuntimeMode({
        supportedRuntimeModes: ["auto-accept-edits"],
        currentRuntimeMode: "auto-accept-edits",
      }),
    ).toBeNull();
    expect(
      resolveProviderSwitchRuntimeMode({
        supportedRuntimeModes: undefined,
        currentRuntimeMode: "full-access",
      }),
    ).toBeNull();
  });
});

describe("resolveInheritedFullAccessDowngrade", () => {
  it("downgrades an inherited global-default full-access mode on load", () => {
    expect(
      resolveInheritedFullAccessDowngrade({
        supportedRuntimeModes: ["auto-accept-edits"],
        currentRuntimeMode: "full-access",
      }),
    ).toBe("auto-accept-edits");
  });

  it("never upgrades a user-chosen stricter mode", () => {
    expect(
      resolveInheritedFullAccessDowngrade({
        supportedRuntimeModes: ["auto-accept-edits"],
        currentRuntimeMode: "approval-required",
      }),
    ).toBeNull();
    expect(
      resolveInheritedFullAccessDowngrade({
        supportedRuntimeModes: ["auto-accept-edits"],
        currentRuntimeMode: "auto-accept-edits",
      }),
    ).toBeNull();
  });

  it("leaves unrestricted providers and full-access-qualified providers alone", () => {
    expect(
      resolveInheritedFullAccessDowngrade({
        supportedRuntimeModes: undefined,
        currentRuntimeMode: "full-access",
      }),
    ).toBeNull();
    expect(
      resolveInheritedFullAccessDowngrade({
        supportedRuntimeModes: ["auto-accept-edits", "full-access"],
        currentRuntimeMode: "full-access",
      }),
    ).toBeNull();
  });
});
