import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ keepRunning: false, hostEnabled: true }));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (value: typeof DEFAULT_UNIFIED_SETTINGS) => unknown) =>
    selector({ ...DEFAULT_UNIFIED_SETTINGS, terminalsKeepRunningAfterQuit: settings.keepRunning }),
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));
vi.mock("../../rpc/serverState", () => ({
  useServerTerminalHostEnabled: () => settings.hostEnabled,
}));

import { TerminalLifecycleSettings } from "./TerminalLifecycleSettings";

const HOST_OFF = "Available when the background terminal host is enabled.";

beforeEach(() => {
  settings.hostEnabled = true;
});

describe("TerminalLifecycleSettings", () => {
  it("is off by default and explains that idle terminals still close", () => {
    settings.keepRunning = false;
    expect(DEFAULT_UNIFIED_SETTINGS.terminalsKeepRunningAfterQuit).toBe(false);
    const markup = renderToStaticMarkup(<TerminalLifecycleSettings platform="MacIntel" />);
    expect(markup).toContain("Keep terminals running after quitting");
    expect(markup).toContain("Idle terminals still close after 10 minutes.");
    expect(markup).toContain('aria-checked="false"');
    expect(markup).not.toContain("Not available on Windows yet.");
    expect(markup).not.toContain(HOST_OFF);
  });

  it("reflects the saved setting", () => {
    settings.keepRunning = true;
    const markup = renderToStaticMarkup(<TerminalLifecycleSettings platform="Linux x86_64" />);
    expect(markup).toContain('aria-checked="true"');
  });

  it("is disabled and off on Windows", () => {
    settings.keepRunning = true;
    const markup = renderToStaticMarkup(<TerminalLifecycleSettings platform="Win32" />);
    expect(markup).toContain("Not available on Windows yet.");
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toMatch(/aria-disabled="true"|data-disabled/);
  });

  it("is disabled and off while the background terminal host is off", () => {
    settings.keepRunning = true;
    settings.hostEnabled = false;
    const markup = renderToStaticMarkup(<TerminalLifecycleSettings platform="MacIntel" />);
    expect(markup).toContain(HOST_OFF);
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toMatch(/aria-disabled="true"|data-disabled/);
  });

  it("names only the Windows reason on Windows, whatever the host state", () => {
    settings.hostEnabled = false;
    const markup = renderToStaticMarkup(<TerminalLifecycleSettings platform="Win32" />);
    expect(markup).toContain("Not available on Windows yet.");
    expect(markup).not.toContain(HOST_OFF);
  });
});
