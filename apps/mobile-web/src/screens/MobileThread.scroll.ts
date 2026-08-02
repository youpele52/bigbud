import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { MessageId, type OrchestrationMessage, type ThreadId } from "@bigbud/contracts";

import {
  deriveMobileReaderPosition,
  readerPositionEquals,
  type ChatReaderPosition,
} from "../logic/mobileReaderPosition.logic";

export function useMobileThreadScroll(input: {
  readonly isRunning: boolean;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly threadId: ThreadId;
  readonly threadLoaded: boolean;
  readonly userTurnAnchorCount: number;
}) {
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledThreadIdRef = useRef<ThreadId | null>(null);
  const lastMessageFingerprintRef = useRef<string | null>(null);
  const [readerPosition, setReaderPosition] = useState<ChatReaderPosition>({
    currentAnchorMessageId: null,
    visibleMessageIds: [],
  });

  useLayoutEffect(() => {
    if (lastScrolledThreadIdRef.current === input.threadId || !input.threadLoaded) return;
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    lastScrolledThreadIdRef.current = input.threadId;
    const timeoutId = window.setTimeout(() => {
      const container = messagesScrollRef.current;
      if (container?.isConnected) container.scrollTop = container.scrollHeight;
    }, 96);
    return () => window.clearTimeout(timeoutId);
  }, [input.threadId, input.threadLoaded]);

  useLayoutEffect(() => {
    if (!input.threadLoaded) return;
    const lastMessage = input.messages.at(-1);
    const fingerprint = lastMessage
      ? `${lastMessage.id}:${lastMessage.text.length}:${lastMessage.streaming ? 1 : 0}`
      : `empty:${input.messages.length}`;
    if (lastMessageFingerprintRef.current === fingerprint) return;
    lastMessageFingerprintRef.current = fingerprint;

    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    const distanceFromBottom =
      scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    if (input.isRunning || distanceFromBottom < 120) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }, [input.isRunning, input.messages, input.threadLoaded]);

  useLayoutEffect(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer || input.userTurnAnchorCount === 0) {
      setReaderPosition((current) =>
        current.currentAnchorMessageId === null && current.visibleMessageIds.length === 0
          ? current
          : { currentAnchorMessageId: null, visibleMessageIds: [] },
      );
      return;
    }

    const publishReaderPosition = () => {
      const next = deriveMobileReaderPosition(scrollContainer);
      setReaderPosition((current) => (readerPositionEquals(current, next) ? current : next));
    };

    publishReaderPosition();
    scrollContainer.addEventListener("scroll", publishReaderPosition, { passive: true });
    const frameId = window.requestAnimationFrame(publishReaderPosition);
    return () => {
      scrollContainer.removeEventListener("scroll", publishReaderPosition);
      window.cancelAnimationFrame(frameId);
    };
  }, [input.messages, input.userTurnAnchorCount]);

  const scrollToMessage = useCallback((messageId: MessageId) => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    const element = scrollContainer.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    );
    element?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, []);

  return { messagesScrollRef, readerPosition, scrollToMessage } as const;
}
