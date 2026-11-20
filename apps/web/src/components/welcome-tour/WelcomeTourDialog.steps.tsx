import { GREETING_NAME_MAX_LENGTH } from "@bigbud/contracts/core/settings.greeting.ts";

import {
  FILE_ACCESS_PROMPT_DESCRIPTION,
  FILE_ACCESS_PROMPT_TITLE,
} from "../file-access/FileAccessLevelChoice";
import {
  GREETING_NAME_DESCRIPTION,
  GREETING_NAME_TITLE,
} from "../settings/GeneralSettingsGreetingName";
import type { useGreetingNameDraft } from "../settings/GeneralSettingsGreetingName.hooks";
import { Input } from "../ui/input";
import type { WelcomeTourStep } from "./WelcomeTourDialog.logic";

export const WELCOME_TOUR_STEP_COPY: Record<
  WelcomeTourStep,
  { title: string; description: string }
> = {
  name: { title: GREETING_NAME_TITLE, description: GREETING_NAME_DESCRIPTION },
  providers: {
    title: "Connect AI",
    description:
      "bigbud works with the AI tools already on this computer. Here is what it found; you can add more anytime in Settings → Providers.",
  },
  "file-access": { title: FILE_ACCESS_PROMPT_TITLE, description: FILE_ACCESS_PROMPT_DESCRIPTION },
};

/** The greeting name input; Enter continues, the value saves through the shared setting. */
export function WelcomeTourNameStep({
  greetingName,
  onSubmit,
}: {
  greetingName: ReturnType<typeof useGreetingNameDraft>;
  onSubmit: () => void;
}) {
  return (
    <Input
      aria-label={GREETING_NAME_TITLE}
      data-welcome-autofocus
      placeholder="Name or nickname"
      maxLength={GREETING_NAME_MAX_LENGTH}
      value={greetingName.draft}
      disabled={greetingName.saving}
      aria-busy={greetingName.saving}
      onChange={(event) => greetingName.setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          onSubmit();
        }
      }}
    />
  );
}
