import { type ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { WELCOME_GREETING } from "@bigbud/shared/greeting.messages";
import { useEffect, useMemo } from "react";

import { useServerConfig } from "../../../rpc/serverState";
import { useStore } from "../../../stores/main/main.store";
import {
  selectShowsWelcomeGreeting,
  useWelcomeTourStore,
} from "../../../stores/ui/welcomeTour.store";
import { greetingForChat, renderGreeting } from "../../../utils/copy/greeting.logic";
import { canShowChatGreeting } from "./ChatGreeting.logic";

export function useChatGreeting({
  threadId,
  name,
  isLocalDraftThread,
  hasContent,
  isWorking,
}: {
  threadId: ThreadId;
  name: string;
  isLocalDraftThread: boolean;
  hasContent: boolean;
  isWorking: boolean;
}): { greeting: string | null; shimmer: boolean } {
  const bootstrapComplete = useStore((state) => state.bootstrapComplete);
  const hydration = useStore((state) => state.threadHydrationById[threadId]);
  const config = useServerConfig();
  const eligible = canShowChatGreeting({
    isLocalDraftThread,
    hydrationStatus: hydration?.status,
    hasOlderMessages: hydration?.status === "loaded" && hydration.nextCursor !== null,
    hasContent,
    isWorking,
    bootstrapComplete,
    settingsReady: config !== null,
  });
  // The chat a finished welcome tour lands on greets the user by name once.
  const welcome = useWelcomeTourStore(selectShowsWelcomeGreeting(threadId)) && eligible;
  const claimWelcomeGreeting = useWelcomeTourStore((state) => state.claimWelcomeGreeting);
  useEffect(() => {
    if (welcome) claimWelcomeGreeting(threadId);
  }, [claimWelcomeGreeting, threadId, welcome]);
  const message = useMemo(
    () => (eligible ? (welcome ? WELCOME_GREETING : greetingForChat(threadId)) : null),
    [eligible, threadId, welcome],
  );
  return {
    greeting: renderGreeting(message, name),
    shimmer: eligible,
  };
}
