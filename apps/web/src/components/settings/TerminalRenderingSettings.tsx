import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

export function TerminalRenderingSettings() {
  const setting = useSettings((settings) => settings.terminalGpuAcceleration);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsRow
      title="Terminal GPU rendering"
      description="Auto (default) and On attempt WebGL when application GPU policy allows, with safe DOM fallback. Off uses DOM. Recently hidden terminals keep their GPU context for quick switching (up to six). Active mode is shown in each terminal."
      resetAction={
        setting !== DEFAULT_UNIFIED_SETTINGS.terminalGpuAcceleration ? (
          <SettingResetButton
            label="terminal GPU rendering"
            onClick={() =>
              updateSettings({
                terminalGpuAcceleration: DEFAULT_UNIFIED_SETTINGS.terminalGpuAcceleration,
              })
            }
          />
        ) : null
      }
      control={
        <Select
          value={setting}
          onValueChange={(value) => {
            if (value === "off" || value === "on" || value === "auto")
              updateSettings({ terminalGpuAcceleration: value });
          }}
        >
          <SelectTrigger
            aria-label="Terminal GPU rendering"
            variant="muted-outline"
            className="w-full sm:w-40"
          >
            <SelectValue>
              {setting === "off" ? "Off (DOM)" : setting === "on" ? "On (WebGL)" : "Auto"}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {["off", "on", "auto"].map((value) => (
              <SelectItem hideIndicator key={value} value={value}>
                {value === "off" ? "Off" : value === "on" ? "On" : "Auto"}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
