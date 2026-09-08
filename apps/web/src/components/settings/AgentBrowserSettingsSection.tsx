import { DEFAULT_UNIFIED_SETTINGS, type AgentBrowserPreference } from "@bigbud/contracts/settings";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const BROWSER_OPTIONS: ReadonlyArray<{ value: AgentBrowserPreference; label: string }> = [
  { value: "bigbud", label: "bigbud browser — Recommended" },
  { value: "system", label: "System default browser" },
];

export function AgentBrowserSettingsSection() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  return (
    <SettingsSection title="Browser">
      <SettingsRow
        title="Default agent browser"
        description="Explicit prompts override this preference. System-browser interaction requires the desktop app, full-access mode, and enabled computer use."
        resetAction={
          settings.agentBrowserPreference !== DEFAULT_UNIFIED_SETTINGS.agentBrowserPreference ? (
            <SettingResetButton
              label="default agent browser"
              onClick={() =>
                updateSettings({
                  agentBrowserPreference: DEFAULT_UNIFIED_SETTINGS.agentBrowserPreference,
                })
              }
            />
          ) : null
        }
        control={
          <Select
            value={settings.agentBrowserPreference}
            onValueChange={(value) => {
              if (value === "bigbud" || value === "system") {
                updateSettings({ agentBrowserPreference: value });
              }
            }}
          >
            <SelectTrigger
              variant="muted-outline"
              className="w-full text-sm sm:w-60"
              aria-label="Default agent browser"
            >
              <SelectValue>
                {BROWSER_OPTIONS.find((option) => option.value === settings.agentBrowserPreference)
                  ?.label ?? "bigbud browser — Recommended"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {BROWSER_OPTIONS.map((option) => (
                <SelectItem
                  className="text-sm"
                  hideIndicator
                  key={option.value}
                  value={option.value}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
