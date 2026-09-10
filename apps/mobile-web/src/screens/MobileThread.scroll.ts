import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { MessageId, type OrchestrationMessage, type ThreadId } from "@bigbud/contracts";

import {
  deriveMobileReaderPosition,
  readerPositionEquals,
  type ChatReaderPosition,
} from "../logic/mobileReaderPosition.logic";
import { shouldFollowMobileThreadContent } from "../logic/mobileThreadFollowing.logic";

export function useMobileThreadScroll(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly threadId: ThreadId;
  readonly threadLoaded: boolean;
  readonly userTurnAnchorCount: number;
}) {
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const lastScrolledThreadIdRef = useRef<ThreadId | null>(null);
  const lastMessageFingerprintRef = useRef<string | null>(null);
  const isFollowingRef = useRef(true);
  const [isFollowing, setIsFollowing] = useState(true);
  const [readerPosition, setReaderPosition] = useState<ChatReaderPosition>({
    currentAnchorMessageId: null,
    visibleMessageIds: [],
  });

  useLayoutEffect(() => {
    if (lastScrolledThreadIdRef.current === input.threadId || !input.threadLoaded) return;
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    isFollowingRef.current = true;
    setIsFollowing(true);
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
    if (isFollowingRef.current) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }
  }, [input.messages, input.threadLoaded]);

  useLayoutEffect(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    const publishFollowing = () => {
      const distanceFromBottom =
        scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
      const next = shouldFollowMobileThreadContent(distanceFromBottom);
      isFollowingRef.current = next;
      setIsFollowing((current) => (current === next ? current : next));
    };
    publishFollowing();
    scrollContainer.addEventListener("scroll", publishFollowing, { passive: true });
    return () => scrollContainer.removeEventListener("scroll", publishFollowing);
  }, [input.threadId]);

  useLayoutEffect(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer || typeof ResizeObserver === "undefined") return;
    const transcriptContent = scrollContainer.querySelector<HTMLElement>(
      '[data-mobile-transcript-content="true"]',
    );
    const observer = new ResizeObserver(() => {
      if (isFollowingRef.current) scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });
    observer.observe(transcriptContent ?? scrollContainer);
    return () => observer.disconnect();
  }, [input.threadId]);

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
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element?.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
  }, []);

  const scrollToLatest = useCallback(() => {
    const scrollContainer = messagesScrollRef.current;
    if (!scrollContainer) return;
    isFollowingRef.current = true;
    setIsFollowing(true);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollContainer.scrollTo({
      top: scrollContainer.scrollHeight,
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, []);

  return {
    isFollowing,
    messagesScrollRef,
    readerPosition,
    scrollToLatest,
    scrollToMessage,
  } as const;
}
