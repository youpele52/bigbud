import {
  BROWSER_SEARCH_ENGINES,
  BROWSER_TAB_LIMIT_MAX,
  BROWSER_TAB_LIMIT_MIN,
  DEFAULT_BROWSER_SEARCH_ENGINE,
  DEFAULT_BROWSER_TAB_LIMIT,
} from "@bigbud/contracts/constants/browser.constant.ts";
import { BROWSER_SEARCH_OPTIONS } from "~/constants/browserSearch";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

import { BrowserAgentSettingsRow } from "./BrowserSettingsSection.agentBrowser";

const TAB_LIMIT_OPTIONS = Array.from(
  { length: BROWSER_TAB_LIMIT_MAX - BROWSER_TAB_LIMIT_MIN + 1 },
  (_, index) => String(BROWSER_TAB_LIMIT_MIN + index),
);

export function BrowserSettingsSection() {
  const engine = useSettings((settings) => settings.browserSearchEngine);
  const tabLimit = useSettings((settings) => settings.browserTabLimit);
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
      <SettingsRow
        title="Maximum browser tabs"
        description="Opening a new page at the limit replaces the oldest tab. Changing the limit does not close any tabs until you open a new page."
        resetAction={
          tabLimit !== DEFAULT_BROWSER_TAB_LIMIT ? (
            <SettingResetButton
              label="maximum browser tabs"
              onClick={() => updateSettings({ browserTabLimit: DEFAULT_BROWSER_TAB_LIMIT })}
            />
          ) : null
        }
        control={
          <Select
            value={String(tabLimit)}
            onValueChange={(value) => {
              if (value !== null && TAB_LIMIT_OPTIONS.includes(value)) {
                updateSettings({ browserTabLimit: Number(value) });
              }
            }}
          >
            <SelectTrigger
              variant="muted-outline"
              className="w-full sm:w-40"
              aria-label="Maximum browser tabs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {TAB_LIMIT_OPTIONS.map((value) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
