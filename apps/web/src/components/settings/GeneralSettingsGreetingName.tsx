import { GREETING_NAME_MAX_LENGTH } from "@bigbud/contracts/core/settings.greeting.ts";

import { Input } from "../ui/input";
import { useGreetingNameDraft } from "./GeneralSettingsGreetingName.hooks";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

export const GREETING_NAME_TITLE = "What should bigbud call you?";
export const GREETING_NAME_DESCRIPTION =
  "An optional name or nickname for new-chat greetings. Shared across this bigbud instance; never sent to AI providers.";

export function GeneralSettingsGreetingName() {
  const { name, draft, setDraft, saving, save } = useGreetingNameDraft();

  return (
    <SettingsRow
      title={GREETING_NAME_TITLE}
      description={GREETING_NAME_DESCRIPTION}
      searchTerms={["name", "nickname", "greeting"]}
      resetAction={
        name && draft.trim() === name && !saving ? (
          <SettingResetButton label="greeting name" onClick={() => void save("")} />
        ) : null
      }
      control={
        <Input
          aria-label={GREETING_NAME_TITLE}
          className="w-full sm:w-56"
          placeholder="Name or nickname"
          maxLength={GREETING_NAME_MAX_LENGTH}
          value={draft}
          disabled={saving}
          aria-busy={saving}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void save(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void save(draft);
            }
          }}
        />
      }
    />
  );
}
