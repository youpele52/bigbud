import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ keepRunning: false }));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (value: typeof DEFAULT_UNIFIED_SETTINGS) => unknown) =>
    selector({ ...DEFAULT_UNIFIED_SETTINGS, terminalsKeepRunningAfterQuit: settings.keepRunning }),
  useUpdateSettings: () => ({ updateSettings: vi.fn() }),
}));

import { TerminalLifecycleSettings } from "./TerminalLifecycleSettings";

describe("TerminalLifecycleSettings", () => {
  it("is off by default and explains that idle terminals still close", () => {
    settings.keepRunning = false;
    expect(DEFAULT_UNIFIED_SETTINGS.terminalsKeepRunningAfterQuit).toBe(false);
    const markup = renderToStaticMarkup(<TerminalLifecycleSettings platform="MacIntel" />);
    expect(markup).toContain("Keep terminals running after quitting");
    expect(markup).toContain("Idle terminals still close after 10 minutes.");
    expect(markup).toContain('aria-checked="false"');
    expect(markup).not.toContain("Not available on Windows yet.");
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
});
