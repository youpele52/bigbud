import type { OrchestrationMessage } from "@bigbud/contracts";
import { useMemo } from "react";

import ChatMarkdown from "~/components/chat/common/ChatMarkdown";
import { UserMessageBody } from "~/components/chat/messages/MessagesTimeline.userMessage";
import { deriveDisplayedUserMessageState } from "~/lib/terminalContext";
import { formatShortTimestamp } from "~/utils/timestamp/timestamp.utils";
import { BigbudLogo } from "../../shell/BigbudLogo";

interface MobileMessagesProps {
  messages: ReadonlyArray<OrchestrationMessage>;
  cwd: string | undefined;
  showEmptyState?: boolean;
}

export function MobileMessages({ messages, cwd, showEmptyState = false }: MobileMessagesProps) {
  const visibleMessages = useMemo(
    () => messages.filter((message) => message.role === "user" || message.role === "assistant"),
    [messages],
  );

  if (visibleMessages.length === 0 && showEmptyState) {
    return (
      <div
        aria-label="No messages yet"
        className="flex min-h-full flex-1 items-center justify-center px-4 py-12"
        data-mobile-empty-state="true"
        role="status"
      >
        <BigbudLogo className="h-8 opacity-45" />
      </div>
    );
  }

  if (visibleMessages.length === 0) return null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
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
      <article className="group min-w-0 rounded-xl px-1 py-0.5 pb-4 transition-colors duration-300">
        <div data-message-id={message.id} data-message-role={message.role}>
          <ChatMarkdown cwd={cwd} isStreaming={message.streaming} text={message.text} />
        </div>
        <div className="mt-1.5 flex justify-start">
          <p className="text-[10px] text-muted-foreground/30">
            {formatShortTimestamp(message.createdAt, "12-hour")}
          </p>
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
      className="group flex flex-col items-end gap-1 pb-4"
      data-message-id={message.id}
      data-message-role={message.role}
      data-scroll-anchor="true"
    >
      <article className="max-w-[80%] rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3 transition-colors duration-300">
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
