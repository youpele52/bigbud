import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { isScrollContainerNearBottom } from "~/utils/scroll";

export function useSideChatAutoScroll(input: {
  contentElement: HTMLDivElement | null;
  contentVersion: unknown;
  isWorking: boolean;
  scrollContainer: HTMLDivElement | null;
}) {
  const shouldStickToBottomRef = useRef(true);
  const pendingFrameRef = useRef<number | null>(null);

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
    shouldStickToBottomRef.current = isScrollContainerNearBottom(scrollContainer);
  }, [input.scrollContainer]);

  useLayoutEffect(() => {
    shouldStickToBottomRef.current = true;
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

  return { onScroll };
}
