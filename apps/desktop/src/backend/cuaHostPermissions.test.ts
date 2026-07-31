import { afterEach, describe, expect, it, vi } from "vitest";

const isTrustedAccessibilityClient = vi.hoisted(() => vi.fn(() => false));

vi.mock("electron", () => ({
  systemPreferences: { isTrustedAccessibilityClient },
}));

import { requestHostAccessibilityPermission } from "./cuaHostPermissions";

const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
  isTrustedAccessibilityClient.mockClear();
});

describe("requestHostAccessibilityPermission", () => {
  it("asks macOS from the Electron host when the user explicitly requests access", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });

    expect(requestHostAccessibilityPermission()).toBe(false);
    expect(isTrustedAccessibilityClient).toHaveBeenCalledWith(true);
  });

  it("does not request Accessibility on other platforms", () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });

    expect(requestHostAccessibilityPermission()).toBeNull();
    expect(isTrustedAccessibilityClient).not.toHaveBeenCalled();
  });
});
