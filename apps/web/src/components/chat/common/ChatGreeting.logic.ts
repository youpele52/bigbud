import type { ThreadHydration } from "../../../stores/main/main.store";

export interface ChatGreetingEligibility {
  readonly isLocalDraftThread: boolean;
  readonly hydrationStatus: ThreadHydration["status"] | undefined;
  readonly hasOlderMessages: boolean;
  readonly hasContent: boolean;
  readonly isWorking: boolean;
  readonly bootstrapComplete: boolean;
  readonly settingsReady: boolean;
}

/** Never mistake a lazy catalog summary or startup placeholder for an empty chat. */
export function canShowChatGreeting(input: ChatGreetingEligibility): boolean {
  return (
    input.bootstrapComplete &&
    input.settingsReady &&
    !input.hasContent &&
    !input.isWorking &&
    (input.isLocalDraftThread ||
      input.hydrationStatus === "complete" ||
      (input.hydrationStatus === "loaded" && !input.hasOlderMessages))
  );
}
