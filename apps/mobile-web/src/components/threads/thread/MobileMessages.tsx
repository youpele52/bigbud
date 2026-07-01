import type { OrchestrationMessage } from "@bigbud/contracts";
import { useMemo } from "react";

import ChatMarkdown from "~/components/chat/common/ChatMarkdown";
import { UserMessageBody } from "~/components/chat/messages/MessagesTimeline.userMessage";
import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";
import { formatShortTimestamp } from "~/utils/timestamp/timestamp.utils";

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
        <div data-message-id={message.id} data-message-role={message.role}>
          <ChatMarkdown cwd={cwd} isStreaming={message.streaming} text={message.text} />
        </div>
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
    <div
      className="group flex flex-col items-end gap-1"
      data-message-id={message.id}
      data-message-role={message.role}
      data-scroll-anchor="true"
    >
      <article className="max-w-[85%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3">
        <UserMessageBody
          cwd={cwd}
          terminalContexts={displayedUserMessage.contexts}
          text={displayedUserMessage.visibleText}
        />
        <div className="mt-1.5 flex justify-end">
          <p className="text-xs text-muted-foreground/50">
            {formatShortTimestamp(message.createdAt, "12-hour")}
          </p>
        </div>
      </article>
    </div>
  );
}
