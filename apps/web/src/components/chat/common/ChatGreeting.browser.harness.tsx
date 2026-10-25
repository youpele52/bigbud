import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";

import { useChatGreeting } from "./ChatGreeting.hooks";
import { ChatGreeting } from "./ChatGreeting";

export function ChatGreetingHarness({
  identity,
  name = "Youpele",
  hasContent = false,
  isLocalDraftThread = true,
  isWorking = false,
}: {
  identity: ThreadId;
  name?: string;
  hasContent?: boolean;
  isLocalDraftThread?: boolean;
  isWorking?: boolean;
}) {
  const presentation = useChatGreeting({
    threadId: identity,
    name,
    hasContent,
    isLocalDraftThread,
    isWorking,
  });
  return <ChatGreeting greeting={presentation.greeting} shimmer={presentation.shimmer} />;
}
