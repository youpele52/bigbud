import type { TerminalGpuAcceleration } from "@bigbud/contracts/core/settings.ts";
import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({
  terminalGpuAcceleration: "auto" as TerminalGpuAcceleration,
  updateSettings: vi.fn(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (value: typeof settings) => unknown) => selector(settings),
  useUpdateSettings: () => ({ updateSettings: settings.updateSettings }),
}));

import { TerminalRenderingSettings } from "./TerminalRenderingSettings";

describe("terminal GPU rendering settings", () => {
  beforeEach(() => {
    settings.terminalGpuAcceleration = DEFAULT_UNIFIED_SETTINGS.terminalGpuAcceleration;
    settings.updateSettings.mockClear();
  });

  it("labels default Auto as active policy with safe fallback, not gated", () => {
    const markup = renderToStaticMarkup(<TerminalRenderingSettings />);
    expect(markup).toContain("Auto (default) and On attempt WebGL");
    expect(markup).toContain("application GPU policy");
    expect(markup).toContain("safe DOM fallback");
    expect(markup).not.toContain("gated");
    expect(markup).not.toContain("packaged native validation");
    expect(TerminalRenderingSettings().props.resetAction).toBeNull();
  });

  it.each(["off", "on"] as const)(
    "preserves %s until the user explicitly resets to Auto",
    (setting) => {
      settings.terminalGpuAcceleration = setting;
      const row = TerminalRenderingSettings();
      expect(settings.updateSettings).not.toHaveBeenCalled();
      const reset = row.props.resetAction as ReactElement<{ onClick: () => void }>;
      reset.props.onClick();
      expect(settings.updateSettings).toHaveBeenCalledExactlyOnceWith({
        terminalGpuAcceleration: "auto",
      });
    },
  );
});
