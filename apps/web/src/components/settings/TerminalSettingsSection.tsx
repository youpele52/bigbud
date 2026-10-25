import {
  DEFAULT_UNIFIED_SETTINGS,
  TERMINAL_FONT_SIZES,
  TerminalFontFamily,
} from "@bigbud/contracts/core/settings.ts";
import { Schema } from "effect";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { TerminalRenderingSettings } from "./TerminalRenderingSettings";
import { TerminalThemeSettings } from "./TerminalThemeSettings";
import { TerminalInteractionSettings } from "./TerminalInteractionSettings";

const TERMINAL_FONT_OPTIONS: Array<{ value: TerminalFontFamily; label: string }> = [
  {
    value: "jetbrains-mono-nerd-font",
    label: "JetBrains Mono Nerd Font Mono",
  },
  {
    value: "meslo-nerd-font-mono",
    label: "Meslo Nerd Font Mono",
  },
  {
    value: "system-monospace",
    label: "System monospace",
  },
];

export function TerminalSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  return (
    <SettingsSection title="Terminal">
      <SettingsRow
        title="Terminal font"
        description="JetBrains Mono is the default with compact terminal spacing. Both bundled Nerd Fonts support prompt icons."
        resetAction={
          settings.terminalFontFamily !== DEFAULT_UNIFIED_SETTINGS.terminalFontFamily ? (
            <SettingResetButton
              label="terminal font"
              onClick={() =>
                updateSettings({
                  terminalFontFamily: DEFAULT_UNIFIED_SETTINGS.terminalFontFamily,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.terminalFontFamily}
            onValueChange={(value) => {
              if (Schema.is(TerminalFontFamily)(value)) {
                updateSettings({ terminalFontFamily: value });
              }
            }}
          >
            <SelectTrigger
              variant="muted-outline"
              className="w-full sm:w-64"
              aria-label="Terminal font family"
            >
              <SelectValue>
                {TERMINAL_FONT_OPTIONS.find(
                  (option) => option.value === settings.terminalFontFamily,
                )?.label ?? "JetBrains Mono Nerd Font Mono"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {TERMINAL_FONT_OPTIONS.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        title="Terminal font size"
        description="Tune the built-in terminal density without changing the rest of the app typography."
        resetAction={
          settings.terminalFontSize !== DEFAULT_UNIFIED_SETTINGS.terminalFontSize ? (
            <SettingResetButton
              label="terminal font size"
              onClick={() =>
                updateSettings({
                  terminalFontSize: DEFAULT_UNIFIED_SETTINGS.terminalFontSize,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={String(settings.terminalFontSize)}
            onValueChange={(value) => {
              const nextFontSize = Number(value);
              if (
                Number.isInteger(nextFontSize) &&
                TERMINAL_FONT_SIZES.includes(nextFontSize as (typeof TERMINAL_FONT_SIZES)[number])
              ) {
                updateSettings({ terminalFontSize: nextFontSize });
              }
            }}
          >
            <SelectTrigger
              variant="muted-outline"
              className="w-full sm:w-32"
              aria-label="Terminal font size"
            >
              <SelectValue>{`${settings.terminalFontSize}px`}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {TERMINAL_FONT_SIZES.map((fontSize) => (
                <SelectItem hideIndicator key={fontSize} value={String(fontSize)}>
                  {fontSize}px
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <TerminalThemeSettings />
      <TerminalRenderingSettings />
      <TerminalInteractionSettings />
    </SettingsSection>
  );
}
