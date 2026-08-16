import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { isScrollContainerNearBottom } from "~/utils/scroll";

export function useSideChatAutoScroll(input: {
  contentElement: HTMLDivElement | null;
  contentVersion: unknown;
  isWorking: boolean;
  scrollContainer: HTMLDivElement | null;
}) {
  const shouldStickToBottomRef = useRef(true);
  const pendingFrameRef = useRef<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const cancelScheduledScroll = useCallback(() => {
    if (pendingFrameRef.current === null) {
      return;
    }
    window.cancelAnimationFrame(pendingFrameRef.current);
    pendingFrameRef.current = null;
  }, []);

  const scheduleScrollToBottom = useCallback(() => {
    if (!shouldStickToBottomRef.current || pendingFrameRef.current !== null) {
      return;
    }
    pendingFrameRef.current = window.requestAnimationFrame(() => {
      pendingFrameRef.current = null;
      const scrollContainer = input.scrollContainer;
      if (!scrollContainer || !shouldStickToBottomRef.current) {
        return;
      }
      scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "auto" });
    });
  }, [input.scrollContainer]);

  const onScroll = useCallback(() => {
    const scrollContainer = input.scrollContainer;
    if (!scrollContainer) {
      return;
    }
    const isNearBottom = isScrollContainerNearBottom(scrollContainer);
    shouldStickToBottomRef.current = isNearBottom;
    const nextShowScrollToBottom = !isNearBottom;
    setShowScrollToBottom((current) =>
      current === nextShowScrollToBottom ? current : nextShowScrollToBottom,
    );
  }, [input.scrollContainer]);

  const scrollToBottom = useCallback(() => {
    const scrollContainer = input.scrollContainer;
    if (!scrollContainer) return;
    cancelScheduledScroll();
    shouldStickToBottomRef.current = true;
    setShowScrollToBottom(false);
    scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "auto" });
  }, [cancelScheduledScroll, input.scrollContainer]);

  useLayoutEffect(() => {
    shouldStickToBottomRef.current = true;
    setShowScrollToBottom(false);
    scheduleScrollToBottom();
    return cancelScheduledScroll;
  }, [cancelScheduledScroll, input.scrollContainer, scheduleScrollToBottom]);

  useLayoutEffect(() => {
    const contentElement = input.contentElement;
    if (!contentElement || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(scheduleScrollToBottom);
    observer.observe(contentElement);
    return () => {
      observer.disconnect();
    };
  }, [input.contentElement, scheduleScrollToBottom]);

  useEffect(() => {
    void input.contentVersion;
    void input.isWorking;
    scheduleScrollToBottom();
  }, [input.contentVersion, input.isWorking, scheduleScrollToBottom]);

  return { onScroll, scrollToBottom, showScrollToBottom };
}
