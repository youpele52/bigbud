import { DEFAULT_UNIFIED_SETTINGS } from "@bigbud/contracts/settings";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

/** Prompt suggestion toggles (Phase 7) for the AI settings section. */
export function PromptSuggestionSettingsRows() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const defaults = DEFAULT_UNIFIED_SETTINGS;
  return (
    <>
      <SettingsRow
        title="Prompt suggestions"
        description="Suggest a next message after each reply. Press Tab or → to use it; it is never sent on its own."
        searchTerms={["suggestion", "follow-up", "ghost text"]}
        resetAction={
          settings.promptSuggestions !== defaults.promptSuggestions ? (
            <SettingResetButton
              label="prompt suggestions"
              onClick={() => updateSettings({ promptSuggestions: defaults.promptSuggestions })}
            />
          ) : null
        }
        control={
          <Switch
            tone="success"
            checked={settings.promptSuggestions}
            onCheckedChange={(checked) => updateSettings({ promptSuggestions: Boolean(checked) })}
            aria-label="Prompt suggestions"
          />
        }
      />

      <SettingsRow
        title="Generate suggestions"
        description="When a provider has no suggestions of its own, ask the thread's model for one. This makes an extra model call after each reply."
        searchTerms={["suggestion", "follow-up"]}
        resetAction={
          settings.generatedPromptSuggestions !== defaults.generatedPromptSuggestions ? (
            <SettingResetButton
              label="generated suggestions"
              onClick={() =>
                updateSettings({ generatedPromptSuggestions: defaults.generatedPromptSuggestions })
              }
            />
          ) : null
        }
        control={
          <Switch
            tone="success"
            checked={settings.generatedPromptSuggestions}
            disabled={!settings.promptSuggestions}
            onCheckedChange={(checked) =>
              updateSettings({ generatedPromptSuggestions: Boolean(checked) })
            }
            aria-label="Generate suggestions"
          />
        }
      />
    </>
  );
}
