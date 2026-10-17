import {
  DEFAULT_UNIFIED_SETTINGS,
  DESKTOP_WINDOW_MATERIALS,
  type DesktopWindowMaterial,
} from "@bigbud/contracts/settings";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { isMacDesktopWindowMaterialSupported } from "../../hooks/useWindowMaterial";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useTheme } from "../../hooks/useTheme";
import { GeneralSettingsGreetingName } from "./GeneralSettingsGreetingName";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
  },
  {
    value: "light",
    label: "Light",
  },
  {
    value: "dark",
    label: "Dark",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

const WINDOW_MATERIAL_OPTIONS: Array<{ value: DesktopWindowMaterial; label: string }> = [
  {
    value: DESKTOP_WINDOW_MATERIALS[0],
    label: "Automatic",
  },
  {
    value: DESKTOP_WINDOW_MATERIALS[1],
    label: "Solid",
  },
  {
    value: DESKTOP_WINDOW_MATERIALS[2],
    label: "Translucent",
  },
];
export function GeneralSettingsSection() {
  const { theme, setTheme } = useTheme();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const showWindowMaterialSetting = isMacDesktopWindowMaterialSupported();

  return (
    <>
      <SettingsSection title="General">
        <GeneralSettingsGreetingName />
        <SettingsRow
          title="Theme"
          description="Choose how bigbud looks across the app."
          resetAction={
            theme !== "system" ? (
              <SettingResetButton label="theme" onClick={() => setTheme("system")} />
            ) : null
          }
          control={
            <Select
              value={theme}
              onValueChange={(value) => {
                if (value === "system" || value === "light" || value === "dark") {
                  setTheme(value);
                }
              }}
            >
              <SelectTrigger
                variant="muted-outline"
                className="w-full sm:w-40"
                aria-label="Theme preference"
              >
                <SelectValue>
                  {THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />

        {showWindowMaterialSetting ? (
          <SettingsRow
            title="Window Material"
            description="Controls the macOS desktop window appearance for shell chrome only. This does not change light or dark theme."
            resetAction={
              settings.windowMaterial !== DEFAULT_UNIFIED_SETTINGS.windowMaterial ? (
                <SettingResetButton
                  label="window material"
                  onClick={() =>
                    updateSettings({
                      windowMaterial: DEFAULT_UNIFIED_SETTINGS.windowMaterial,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={settings.windowMaterial}
                onValueChange={(value) => {
                  if (
                    value === DESKTOP_WINDOW_MATERIALS[0] ||
                    value === DESKTOP_WINDOW_MATERIALS[1] ||
                    value === DESKTOP_WINDOW_MATERIALS[2]
                  ) {
                    updateSettings({ windowMaterial: value });
                  }
                }}
              >
                <SelectTrigger
                  variant="muted-outline"
                  className="w-full sm:w-40"
                  aria-label="Window material preference"
                >
                  <SelectValue>
                    {WINDOW_MATERIAL_OPTIONS.find(
                      (option) => option.value === settings.windowMaterial,
                    )?.label ?? "Automatic"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {WINDOW_MATERIAL_OPTIONS.map((option) => (
                    <SelectItem hideIndicator key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
        ) : null}

        <SettingsRow
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== DEFAULT_UNIFIED_SETTINGS.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <Select
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value === "locale" || value === "12-hour" || value === "24-hour") {
                  updateSettings({ timestampFormat: value });
                }
              }}
            >
              <SelectTrigger
                variant="muted-outline"
                className="w-full sm:w-40"
                aria-label="Timestamp format"
              >
                <SelectValue>{TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="locale">
                  {TIMESTAMP_FORMAT_LABELS.locale}
                </SelectItem>
                <SelectItem hideIndicator value="12-hour">
                  {TIMESTAMP_FORMAT_LABELS["12-hour"]}
                </SelectItem>
                <SelectItem hideIndicator value="24-hour">
                  {TIMESTAMP_FORMAT_LABELS["24-hour"]}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Open web links in bigbud"
          description="Open web links from terminal, chat, and help in the in-app browser. Turn off to use your system default browser (a new tab in the web app)."
          resetAction={
            !settings.openWebLinksInApp ? (
              <SettingResetButton
                label="web link browser"
                onClick={() => updateSettings({ openWebLinksInApp: true })}
              />
            ) : null
          }
          control={
            <Switch
              tone="success"
              checked={settings.openWebLinksInApp}
              onCheckedChange={(checked) => updateSettings({ openWebLinksInApp: Boolean(checked) })}
              aria-label="Open web links in bigbud"
            />
          }
        />
        <SettingsRow
          title="Diff line wrapping"
          description="Set the default wrap state when the diff panel opens."
          resetAction={
            settings.diffWordWrap !== DEFAULT_UNIFIED_SETTINGS.diffWordWrap ? (
              <SettingResetButton
                label="diff line wrapping"
                onClick={() =>
                  updateSettings({
                    diffWordWrap: DEFAULT_UNIFIED_SETTINGS.diffWordWrap,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              tone="success"
              checked={settings.diffWordWrap}
              onCheckedChange={(checked) => updateSettings({ diffWordWrap: Boolean(checked) })}
              aria-label="Wrap diff lines by default"
            />
          }
        />
      </SettingsSection>
    </>
  );
}
