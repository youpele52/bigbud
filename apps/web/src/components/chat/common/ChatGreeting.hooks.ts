import { type ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { useMemo } from "react";

import { useServerConfig } from "../../../rpc/serverState";
import { useStore } from "../../../stores/main/main.store";
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
  const message = useMemo(
    () => (eligible ? greetingForChat(threadId) : null),
    [eligible, threadId],
  );
  return {
    greeting: renderGreeting(message, name),
    shimmer: eligible,
  };
}
