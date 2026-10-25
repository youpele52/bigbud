import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

/** OD4: the kill switch for agent-chosen models on delegated (child) threads. */
export function DelegatedThreadsSettingsSection() {
  const choice = useSettings((settings) => settings.delegatedThreadModelChoice);
  const { updateSettings } = useUpdateSettings();
  const agentChooses = choice === "agent";

  return (
    <SettingsSection title="Delegated threads">
      <SettingsRow
        title="Let agents choose models for delegated threads"
        description="Agents may request a provider and model for threads they create. Only models you can use are accepted; otherwise the parent thread's model is used."
        searchTerms={["delegate", "child", "tributary", "model", "provider", "agent"]}
        resetAction={
          choice !== DEFAULT_UNIFIED_SETTINGS.delegatedThreadModelChoice ? (
            <SettingResetButton
              label="delegated thread model choice"
              onClick={() =>
                updateSettings({
                  delegatedThreadModelChoice: DEFAULT_UNIFIED_SETTINGS.delegatedThreadModelChoice,
                })
              }
            />
          ) : undefined
        }
        control={
          <Switch
            tone="success"
            checked={agentChooses}
            onCheckedChange={(checked) =>
              updateSettings({ delegatedThreadModelChoice: checked ? "agent" : "parent" })
            }
            aria-label="Let agents choose models for delegated threads"
          />
        }
      />
    </SettingsSection>
  );
}
