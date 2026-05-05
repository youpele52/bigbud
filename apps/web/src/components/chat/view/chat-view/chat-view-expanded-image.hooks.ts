import { useCallback, useEffect } from "react";

import type { ChatViewBaseState } from "./chat-view-base-state.hooks";

export function useChatViewExpandedImage(base: ChatViewBaseState) {
  const closeExpandedImage = useCallback(() => {
    base.setExpandedImage(null);
  }, [base]);

  const navigateExpandedImage = useCallback(
    (direction: -1 | 1) => {
      base.setExpandedImage((existing) => {
        if (!existing || existing.images.length <= 1) {
          return existing;
        }
        const nextIndex =
          (existing.index + direction + existing.images.length) % existing.images.length;
        return nextIndex === existing.index ? existing : { ...existing, index: nextIndex };
      });
    },
    [base],
  );

  useEffect(() => {
    if (!base.expandedImage) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const expandedImage = base.expandedImage;
      if (!expandedImage) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeExpandedImage();
        return;
      }
      if (expandedImage.images.length <= 1) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        navigateExpandedImage(-1);
        return;
      }
      if (event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      navigateExpandedImage(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [base.expandedImage, closeExpandedImage, navigateExpandedImage]);

  return {
    closeExpandedImage,
    navigateExpandedImage,
  };
}
