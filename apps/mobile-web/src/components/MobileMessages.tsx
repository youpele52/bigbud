import type { OrchestrationMessage } from "@bigbud/contracts";
import { useMemo } from "react";

import ChatMarkdown from "~/components/chat/common/ChatMarkdown";
import { UserMessageBody } from "~/components/chat/messages/MessagesTimeline.userMessage";
import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";

interface MobileMessagesProps {
  messages: ReadonlyArray<OrchestrationMessage>;
  cwd: string | undefined;
}

export function MobileMessages({ messages, cwd }: MobileMessagesProps) {
  const visibleMessages = useMemo(
    () => messages.filter((message) => message.role === "user" || message.role === "assistant"),
    [messages],
  );

  if (visibleMessages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12 text-sm text-muted-foreground">
        No messages yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 px-1 py-4">
      {visibleMessages.map((message) => (
        <MobileMessage key={message.id} cwd={cwd} message={message} />
      ))}
    </div>
  );
}

function MobileMessage({
  message,
  cwd,
}: {
  message: OrchestrationMessage;
  cwd: string | undefined;
}) {
  if (message.role === "assistant") {
    return (
      <article className="min-w-0 px-1">
        <ChatMarkdown cwd={cwd} isStreaming={false} text={message.text} />
      </article>
    );
  }

  const displayedUserMessage = deriveDisplayedUserMessageState(message.text);
  if (
    displayedUserMessage.visibleText.trim().length === 0 &&
    displayedUserMessage.contexts.length === 0
  ) {
    return null;
  }

  return (
    <article className="min-w-0 rounded-xl bg-card/40 px-3 py-2.5">
      <UserMessageBody
        cwd={cwd}
        terminalContexts={displayedUserMessage.contexts}
        text={displayedUserMessage.visibleText}
      />
    </article>
  );
}
