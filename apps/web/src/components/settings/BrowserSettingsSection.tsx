import {
  BROWSER_SEARCH_ENGINES,
  DEFAULT_BROWSER_SEARCH_ENGINE,
} from "@bigbud/contracts/constants/browser.constant.ts";
import { BROWSER_SEARCH_OPTIONS } from "~/constants/browserSearch";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

import { BrowserAgentSettingsRow } from "./BrowserSettingsSection.agentBrowser";

export function BrowserSettingsSection() {
  const engine = useSettings((settings) => settings.browserSearchEngine);
  const { updateSettings } = useUpdateSettings();
  return (
    <SettingsSection title="Browser">
      <BrowserAgentSettingsRow />
      <SettingsRow
        title="Default search engine"
        description="Choose the search engine for the built-in browser's address bar and selected text searches."
        resetAction={
          engine !== DEFAULT_BROWSER_SEARCH_ENGINE ? (
            <SettingResetButton
              label="default search engine"
              onClick={() => updateSettings({ browserSearchEngine: DEFAULT_BROWSER_SEARCH_ENGINE })}
            />
          ) : null
        }
        control={
          <Select
            value={engine}
            onValueChange={(value) => {
              const selected = BROWSER_SEARCH_ENGINES.find((engine) => engine === value);
              if (selected) updateSettings({ browserSearchEngine: selected });
            }}
          >
            <SelectTrigger
              variant="muted-outline"
              className="w-full sm:w-40"
              aria-label="Default search engine"
            >
              <SelectValue>{BROWSER_SEARCH_OPTIONS[engine].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {BROWSER_SEARCH_ENGINES.map((engine) => (
                <SelectItem hideIndicator key={engine} value={engine}>
                  {BROWSER_SEARCH_OPTIONS[engine].label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
