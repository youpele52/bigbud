import { type MessageId } from "@bigbud/contracts";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import {
  scrollContainerToAnchor,
  scrollContainerToMessage,
} from "../scroller/chatScroll.anchor.logic";
import { type ChatReaderPosition } from "../scroller/chatScroll.constants";
import { readerPositionEquals } from "../scroller/chatScroll.readerPosition.logic";

interface UseChatScrollExtensionsInput {
  activeThreadId: string | null;
  latestUserMessageId: MessageId | null;
  messagesScrollRef: React.RefObject<HTMLDivElement | null>;
  scheduleStickToBottom: () => void;
  setShowScrollToBottom: React.Dispatch<React.SetStateAction<boolean>>;
  shouldAutoScrollRef: React.RefObject<boolean>;
}

export function useChatScrollExtensions({
  activeThreadId,
  latestUserMessageId,
  messagesScrollRef,
  scheduleStickToBottom,
  setShowScrollToBottom,
  shouldAutoScrollRef,
}: UseChatScrollExtensionsInput) {
  const lastAnchoredUserMessageIdRef = useRef<MessageId | null>(null);
  const [readerPosition, setReaderPosition] = useState<ChatReaderPosition>({
    currentAnchorMessageId: null,
    visibleMessageIds: [],
  });

  const releaseAutoScroll = useCallback(() => {
    shouldAutoScrollRef.current = false;
    setShowScrollToBottom(true);
  }, [setShowScrollToBottom, shouldAutoScrollRef]);

  const scrollToUserAnchor = useCallback(
    (messageId: MessageId, behavior: ScrollBehavior = "auto") => {
      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) {
        return false;
      }

      const anchorElement = scrollContainer.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"][data-scroll-anchor="true"]`,
      );
      if (!anchorElement) {
        return false;
      }

      scrollContainerToAnchor(scrollContainer, anchorElement, behavior);
      return true;
    },
    [messagesScrollRef],
  );

  const scrollToUserTurnAnchor = useCallback(
    (messageId: MessageId) => {
      shouldAutoScrollRef.current = true;
      setShowScrollToBottom(false);

      const attempt = () => {
        if (!shouldAutoScrollRef.current) {
          return;
        }
        if (scrollToUserAnchor(messageId)) {
          return;
        }
        scheduleStickToBottom();
      };

      window.requestAnimationFrame(attempt);
      window.setTimeout(attempt, 96);
    },
    [scheduleStickToBottom, scrollToUserAnchor, setShowScrollToBottom, shouldAutoScrollRef],
  );

  const scrollToMessage = useCallback(
    (
      messageId: MessageId,
      options?: {
        align?: "start" | "center" | "end";
        behavior?: ScrollBehavior;
      },
    ) => {
      releaseAutoScroll();

      const scrollContainer = messagesScrollRef.current;
      if (!scrollContainer) {
        return false;
      }

      const messageElement = scrollContainer.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      if (!messageElement) {
        return false;
      }

      scrollContainerToMessage(scrollContainer, messageElement, options);
      return true;
    },
    [messagesScrollRef, releaseAutoScroll],
  );

  const updateReaderPosition = useCallback((next: ChatReaderPosition) => {
    setReaderPosition((current) => (readerPositionEquals(current, next) ? current : next));
  }, []);

  useLayoutEffect(() => {
    lastAnchoredUserMessageIdRef.current = null;
    setReaderPosition({
      currentAnchorMessageId: null,
      visibleMessageIds: [],
    });
  }, [activeThreadId]);

  useLayoutEffect(() => {
    if (!latestUserMessageId) {
      return;
    }
    if (lastAnchoredUserMessageIdRef.current === latestUserMessageId) {
      return;
    }
    lastAnchoredUserMessageIdRef.current = latestUserMessageId;
    if (!shouldAutoScrollRef.current) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      if (!shouldAutoScrollRef.current) {
        return;
      }
      scrollToUserAnchor(latestUserMessageId);
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [latestUserMessageId, scrollToUserAnchor, shouldAutoScrollRef]);

  return {
    readerPosition,
    releaseAutoScroll,
    scrollToMessage,
    scrollToUserAnchor,
    scrollToUserTurnAnchor,
    updateReaderPosition,
  };
}

export type ChatScrollExtensionsState = ReturnType<typeof useChatScrollExtensions>;
