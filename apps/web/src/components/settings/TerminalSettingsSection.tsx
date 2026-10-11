import {
  DEFAULT_UNIFIED_SETTINGS,
  TERMINAL_FONT_FAMILIES,
  TERMINAL_FONT_SIZES,
  type TerminalFontFamily,
} from "@bigbud/contracts/settings";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { TerminalRenderingSettings } from "./TerminalRenderingSettings";

const TERMINAL_FONT_OPTIONS: Array<{ value: TerminalFontFamily; label: string }> = [
  {
    value: TERMINAL_FONT_FAMILIES[0],
    label: "Meslo Nerd Font Mono",
  },
  {
    value: TERMINAL_FONT_FAMILIES[1],
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
        description="Use the bundled Meslo Nerd Font by default so prompt icons render correctly in the built-in terminal."
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
              if (value === TERMINAL_FONT_FAMILIES[0] || value === TERMINAL_FONT_FAMILIES[1]) {
                updateSettings({ terminalFontFamily: value });
              }
            }}
          >
            <SelectTrigger
              variant="muted-outline"
              className="w-full sm:w-52"
              aria-label="Terminal font family"
            >
              <SelectValue>
                {TERMINAL_FONT_OPTIONS.find(
                  (option) => option.value === settings.terminalFontFamily,
                )?.label ?? "Meslo Nerd Font Mono"}
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

      <TerminalRenderingSettings />
    </SettingsSection>
  );
}
