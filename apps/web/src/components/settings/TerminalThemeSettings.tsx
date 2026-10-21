import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { TerminalThemeSelect } from "./TerminalThemeSelect";

const SLOTS = [
  {
    key: "terminalThemeDark",
    kind: "dark",
    title: "Terminal theme (dark appearance)",
    description:
      "Colours used while the app is dark. bigbud matches the app surface; built-in themes set the terminal's own background, which full-screen apps such as opencode show through.",
  },
  {
    key: "terminalThemeLight",
    kind: "light",
    title: "Terminal theme (light appearance)",
    description: "Colours used while the app is light. Changes apply to open terminals in place.",
  },
] as const;

export function TerminalThemeSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  return SLOTS.map((slot) => (
    <SettingsRow
      key={slot.key}
      title={slot.title}
      description={slot.description}
      resetAction={
        settings[slot.key] !== DEFAULT_UNIFIED_SETTINGS[slot.key] ? (
          <SettingResetButton
            label={slot.title.toLowerCase()}
            onClick={() => updateSettings({ [slot.key]: DEFAULT_UNIFIED_SETTINGS[slot.key] })}
          />
        ) : null
      }
      control={
        <TerminalThemeSelect
          kind={slot.kind}
          value={settings[slot.key]}
          label={slot.title}
          onChange={(name) => updateSettings({ [slot.key]: name })}
        />
      }
    />
  ));
}
