import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSettings = vi.hoisted(() => ({
  computerUseEnabled: false,
  hasSeenComputerUsePrompt: false,
  computerUseCheckInIntervalMs: 10 * 60_000,
  computerUseActionTimeoutMs: 15 * 60_000,
}));
const mockNativeApi = vi.hoisted(() => ({ present: true as boolean }));
const mockComputerUse = vi.hoisted(() => ({
  permissions: null as null | {
    runtimeAvailable: boolean;
    granted: boolean;
    pendingHostAccessibilityApproval?: boolean;
    message: string | null;
    permissions: Array<{ name: string; granted: boolean }>;
    source?: { attribution: string | null; embedded: boolean | null; hostBundleId: string | null };
  },
}));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => mockSettings,
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));

vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => (mockNativeApi.present ? ({} as never) : null),
}));

vi.mock("../../lib/desktopComputerUseReactQuery", () => ({
  useDesktopComputerUseStatus: () => ({ data: null, isLoading: false }),
  useDesktopComputerUsePermissions: () => ({
    data: mockComputerUse.permissions,
    isLoading: false,
  }),
  desktopComputerUsePermissionsQueryOptions: () => ({ queryKey: ["permissions"] }),
  setDesktopComputerUseStatusQueryData: vi.fn(),
  setDesktopComputerUsePermissionsQueryData: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { ComputerUseAccessSettingsSection } from "./ComputerUseAccessSettingsSection";
import { normalizeComputerUsePermissionMessage } from "../computer-use/computerUsePermissionMessage";

describe("ComputerUseAccessSettingsSection", () => {
  beforeEach(() => {
    Object.defineProperty(Navigator.prototype, "platform", {
      configurable: true,
      value: "MacIntel",
    });
  });

  beforeEach(() => {
    mockSettings.computerUseEnabled = false;
    mockNativeApi.present = true;
    mockComputerUse.permissions = null;
  });

  it("renders nothing outside the desktop shell", () => {
    mockNativeApi.present = false;

    expect(renderToStaticMarkup(<ComputerUseAccessSettingsSection />)).toBe("");
  });

  it("shows limited capability guidance when desktop automation is disabled", () => {
    mockSettings.computerUseEnabled = false;

    const markup = renderToStaticMarkup(<ComputerUseAccessSettingsSection />);

    expect(markup).toContain("Computer Use");
    expect(markup).toContain("Limited capability");
    expect(markup).toContain("agents cannot open or read native apps");
    expect(markup).toContain("Check-in interval");
    expect(markup).toContain("Action timeout");
  });

  it("shows the macOS permissions row in the desktop shell on macOS", () => {
    mockSettings.computerUseEnabled = true;

    const markup = renderToStaticMarkup(<ComputerUseAccessSettingsSection />);

    expect(markup).toContain("macOS permissions");
    expect(markup).toContain("Check access");
  });

  it("shows pending host approval and the active bundle identity", () => {
    mockSettings.computerUseEnabled = true;
    mockComputerUse.permissions = {
      runtimeAvailable: true,
      granted: false,
      pendingHostAccessibilityApproval: true,
      message: "Approve Accessibility, then check again.",
      permissions: [{ name: "accessibility", granted: false }],
      source: {
        attribution: "host",
        embedded: true,
        hostBundleId: "ai.bigbud.desktop.dev",
      },
    };

    const markup = renderToStaticMarkup(<ComputerUseAccessSettingsSection />);

    expect(markup).toContain("Waiting for Accessibility approval");
    expect(markup).toContain("ai.bigbud.desktop.dev");
  });

  it("hides technical guidance after all permissions are granted", () => {
    mockSettings.computerUseEnabled = true;
    mockComputerUse.permissions = {
      runtimeAvailable: true,
      granted: true,
      message: "ℹ️ Embedded mode: status reflects the HOST app's TCC grant.",
      permissions: [{ name: "accessibility", granted: true }],
      source: {
        attribution: "host",
        embedded: true,
        hostBundleId: "ai.bigbud.desktop.dev",
      },
    };

    const markup = renderToStaticMarkup(<ComputerUseAccessSettingsSection />);

    expect(markup).not.toContain("Embedded mode:");
    expect(markup).toContain("Permission attribution:");
    expect(markup).toContain("ai.bigbud.desktop.dev");
  });

  it("uses generic desktop wording on non-mac platforms", () => {
    Object.defineProperty(Navigator.prototype, "platform", {
      configurable: true,
      value: "Linux x86_64",
    });
    mockSettings.computerUseEnabled = true;

    const markup = renderToStaticMarkup(<ComputerUseAccessSettingsSection />);

    expect(markup).toContain("Desktop permissions");
    expect(markup).toContain("native desktop apps");
    expect(markup).not.toContain("macOS permissions");
    expect(markup).not.toContain("Calendar and Reminders");
    expect(markup).not.toContain("System Settings");
  });

  it("keeps every driver permission status alongside informational guidance", () => {
    expect(
      normalizeComputerUsePermissionMessage(
        "✅ Accessibility: granted. ✅ Screen Recording: granted. ℹ️ Embedded mode: status reflects the HOST app's TCC grant.",
      ),
    ).toBe(
      "Accessibility: granted.\nScreen Recording: granted.\nEmbedded mode: status reflects the HOST app's TCC grant.",
    );
  });
});
