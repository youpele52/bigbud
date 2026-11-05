import { describe, expect, it } from "vitest";

import {
  downgradeMuseInheritedRuntimeMode,
  museInteractionModeSupported,
  resolveMusePermissionSelection,
} from "./Provider.permissions.ts";

describe("Muse permission mapping (Phase 0 qualified)", () => {
  it("maps auto-accept-edits to :ask-me with promptUnmatched approval", () => {
    const resolved = resolveMusePermissionSelection("auto-accept-edits");
    expect(resolved).toEqual({
      supported: true,
      selection: { permissionProfile: ":ask-me", approvalMode: "promptUnmatched" },
    });
  });

  it("leaves approval-required unsupported rather than reinterpreting a native label", () => {
    const resolved = resolveMusePermissionSelection("approval-required");
    expect(resolved.supported).toBe(false);
    if (!resolved.supported) expect(resolved.reason).toContain("auto-accept-edits");
  });

  it("never derives full-access from bigbud's global default", () => {
    expect(resolveMusePermissionSelection("full-access").supported).toBe(false);
  });

  it("downgrades only an inherited full-access mode, never a stricter choice", () => {
    expect(downgradeMuseInheritedRuntimeMode("full-access")).toBe("auto-accept-edits");
    expect(downgradeMuseInheritedRuntimeMode("approval-required")).toBe("approval-required");
    expect(downgradeMuseInheritedRuntimeMode("auto-accept-edits")).toBe("auto-accept-edits");
  });

  it("supports only the default interaction mode", () => {
    expect(museInteractionModeSupported("default")).toBe(true);
    expect(museInteractionModeSupported("plan")).toBe(false);
  });
});
