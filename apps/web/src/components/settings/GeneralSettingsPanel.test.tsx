import {
  DEFAULT_UNIFIED_SETTINGS,
  TERMINAL_FONT_FAMILIES,
  TERMINAL_FONT_SIZES,
  type UnifiedSettings,
} from "@bigbud/contracts/settings";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  settings: {} as UnifiedSettings,
  updateSettings: vi.fn(),
}));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector?: (settings: UnifiedSettings) => unknown) =>
    selector ? selector(mock.settings) : mock.settings,
  useUpdateSettings: () => ({ updateSettings: mock.updateSettings }),
}));

import { GeneralSettingsPanel } from "./GeneralSettingsPanel";
import { TerminalSettingsSection } from "./TerminalSettingsSection";

type SettingRow = ReactElement<{
  title: string;
  resetAction: ReactElement<{ onClick: () => void }> | null;
  control: ReactElement<{
    value: string;
    onValueChange: (value: string) => void;
  }>;
}>;

describe("GeneralSettingsPanel terminal group", () => {
  beforeEach(() => {
    mock.settings = { ...DEFAULT_UNIFIED_SETTINGS };
    mock.updateSettings.mockClear();
  });

  it("places the terminal settings in their own shared section immediately after Threads", () => {
    const markup = renderToStaticMarkup(<GeneralSettingsPanel />);
    const sections = [...markup.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/g)].map(
      ([section]) => ({
        markup: section,
        title: section.match(/<h2\b[^>]*>(.*?)<\/h2>/)?.[1],
        rows: [...section.matchAll(/<h3\b[^>]*>(.*?)<\/h3>/g)].map((match) => match[1]),
      }),
    );

    expect(sections.map(({ title }) => title)).toEqual([
      "General",
      "Threads",
      "Terminal",
      expect.stringContaining("Learning projects"),
    ]);
    expect(sections[0]?.rows).toEqual([
      "What should bigbud call you?",
      "Theme",
      "Time format",
      "Open web links in bigbud",
      "Diff line wrapping",
    ]);
    expect(sections[2]?.rows).toEqual([
      "Terminal font",
      "Terminal font size",
      "Terminal theme (dark appearance)",
      "Terminal theme (light appearance)",
      "Terminal GPU rendering",
      "Terminal scroll speed",
      "Terminal fast scroll speed",
      "Full-screen app scroll speed",
      "Terminal ligatures",
      "Terminal inline images",
    ]);
    const sectionClasses = sections.map(
      ({ markup: section }) => section.match(/^<section class="([^"]+)"/)?.[1],
    );
    const cardClasses = sections.map(
      ({ markup: section }) => section.match(/<div class="([^"]*rounded-2xl[^"]*)"/)?.[1],
    );
    expect(sectionClasses[2]).toBe(sectionClasses[1]);
    expect(cardClasses[2]).toBeTruthy();
    expect(cardClasses[2]).toBe(cardClasses[1]);
    expect(markup).toContain('aria-label="What should bigbud call you?"');
    expect(markup).toContain('aria-label="Terminal font family"');
    expect(markup).toContain('aria-label="Terminal font size"');
    expect(markup).toContain('aria-label="Terminal GPU rendering"');
    expect(markup).toContain("JetBrains Mono Nerd Font Mono");
    expect(mock.updateSettings).not.toHaveBeenCalled();
  });

  it("keeps the font defaults, accepted options, validation, and reset behavior", () => {
    const [font, size] = TerminalSettingsSection().props.children as SettingRow[];
    expect(font!.props.resetAction).toBeNull();
    expect(size!.props.resetAction).toBeNull();
    expect(font!.props.control.props.value).toBe(DEFAULT_UNIFIED_SETTINGS.terminalFontFamily);
    expect(size!.props.control.props.value).toBe(String(DEFAULT_UNIFIED_SETTINGS.terminalFontSize));

    for (const value of TERMINAL_FONT_FAMILIES) {
      font!.props.control.props.onValueChange(value);
      expect(mock.updateSettings).toHaveBeenLastCalledWith({ terminalFontFamily: value });
    }
    for (const value of TERMINAL_FONT_SIZES) {
      size!.props.control.props.onValueChange(String(value));
      expect(mock.updateSettings).toHaveBeenLastCalledWith({ terminalFontSize: value });
    }
    mock.updateSettings.mockClear();
    font!.props.control.props.onValueChange("invalid font");
    for (const value of ["invalid", "12.5", "-1", "1000"]) {
      size!.props.control.props.onValueChange(value);
    }
    expect(mock.updateSettings).not.toHaveBeenCalled();

    mock.settings = {
      ...mock.settings,
      terminalFontFamily: TERMINAL_FONT_FAMILIES[1],
      terminalFontSize: TERMINAL_FONT_SIZES.find(
        (value) => value !== DEFAULT_UNIFIED_SETTINGS.terminalFontSize,
      )!,
    };
    const [changedFont, changedSize] = TerminalSettingsSection().props.children as SettingRow[];
    expect(changedFont!.props.control.props.value).toBe(mock.settings.terminalFontFamily);
    expect(changedSize!.props.control.props.value).toBe(String(mock.settings.terminalFontSize));
    expect(mock.updateSettings).not.toHaveBeenCalled();
    changedFont!.props.resetAction!.props.onClick();
    expect(mock.updateSettings).toHaveBeenLastCalledWith({
      terminalFontFamily: DEFAULT_UNIFIED_SETTINGS.terminalFontFamily,
    });
    changedSize!.props.resetAction!.props.onClick();
    expect(mock.updateSettings).toHaveBeenLastCalledWith({
      terminalFontSize: DEFAULT_UNIFIED_SETTINGS.terminalFontSize,
    });
  });
});
