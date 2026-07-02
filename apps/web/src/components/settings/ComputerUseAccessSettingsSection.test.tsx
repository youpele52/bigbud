import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSettings = vi.hoisted(() => ({
  computerUseEnabled: false,
  hasSeenComputerUsePrompt: false,
  computerUseCheckInIntervalMs: 10 * 60_000,
  computerUseActionTimeoutMs: 15 * 60_000,
}));
const mockNativeApi = vi.hoisted(() => ({ present: true as boolean }));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: () => mockSettings,
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));

vi.mock("../../rpc/nativeApi", () => ({
  readNativeApi: () => (mockNativeApi.present ? ({} as never) : null),
}));

vi.mock("../../lib/desktopComputerUseReactQuery", () => ({
  useDesktopComputerUseStatus: () => ({ data: null, isLoading: false }),
  useDesktopComputerUsePermissions: () => ({ data: null, isLoading: false }),
  desktopComputerUsePermissionsQueryOptions: () => ({ queryKey: ["permissions"] }),
  setDesktopComputerUseStatusQueryData: vi.fn(),
  setDesktopComputerUsePermissionsQueryData: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { ComputerUseAccessSettingsSection } from "./ComputerUseAccessSettingsSection";

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
    expect(markup).toContain("Request access");
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
});
