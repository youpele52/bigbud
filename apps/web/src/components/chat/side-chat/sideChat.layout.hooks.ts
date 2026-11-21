import { type RefObject, useLayoutEffect } from "react";

import {
  CHAT_FLOATING_PANEL_ANCHOR_SELECTOR,
  CHAT_FLOATING_PANEL_INSET_PX,
} from "~/components/chat/common/chatFloatingPanel.layout";

const LAYOUT_VARIABLES = [
  "--side-chat-top",
  "--side-chat-bottom",
  "--side-chat-available-height",
] as const;

/**
 * Sidecar placement: top-aligned with the Tasks panel (inset below the messages area top) and
 * bottom-aligned just above the composer. While staggered (`--chat-floating-panel-stagger`) it
 * moves down and left by that offset and shrinks so its bottom stays put. Without a measured layout
 * it falls back to sitting above a typical composer.
 */
export const SIDE_CHAT_PANEL_POSITION_CLASS_NAME =
  "absolute z-30 h-[calc(var(--side-chat-available-height,66dvh)_-_var(--chat-floating-panel-stagger,0px))] max-h-[calc(var(--side-chat-available-height,calc(100dvh-1.5rem))_-_var(--chat-floating-panel-stagger,0px))] min-h-0 resize-y";

export const SIDE_CHAT_PANEL_POSITION_STYLE = {
  // Invalid (falls back to `auto`) until `--side-chat-top` is measured.
  top: "calc(var(--side-chat-top) + var(--chat-floating-panel-stagger, 0px))",
  right: "calc(0.75rem + var(--chat-floating-panel-stagger, 0px))",
  bottom: "var(--side-chat-bottom, 7.75rem)",
} as const;

/**
 * Publishes the Sidecar's offsets on `[data-chat-view-root]` (its containing block), measured from
 * the floating-panel anchor and the main composer, and keeps them current as either resizes.
 */
export function useSideChatLayoutVariables(panelRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = panelRef.current?.closest<HTMLElement>("[data-chat-view-root]");
    const anchor = root?.querySelector<HTMLElement>(CHAT_FLOATING_PANEL_ANCHOR_SELECTOR);
    const composer = root?.querySelector<HTMLElement>("[data-chat-composer-form]");
    if (!root || !anchor || !composer) return;

    const updateLayoutVariables = () => {
      const rootRect = root.getBoundingClientRect();
      // Offsets are relative to the root's padding box, which positions the absolute panel.
      const rootTop = rootRect.top + root.clientTop;
      const rootBottom = rootTop + root.clientHeight;
      const top = anchor.getBoundingClientRect().top - rootTop + CHAT_FLOATING_PANEL_INSET_PX;
      const bottom =
        rootBottom - composer.getBoundingClientRect().top + CHAT_FLOATING_PANEL_INSET_PX;
      root.style.setProperty("--side-chat-top", `${top}px`);
      root.style.setProperty("--side-chat-bottom", `${bottom}px`);
      root.style.setProperty(
        "--side-chat-available-height",
        `${Math.max(0, root.clientHeight - top - bottom)}px`,
      );
    };
    updateLayoutVariables();
    const clearLayoutVariables = () => {
      for (const variable of LAYOUT_VARIABLES) root.style.removeProperty(variable);
    };
    if (typeof ResizeObserver === "undefined") {
      return clearLayoutVariables;
    }
    // Banners above the anchor and toolbars below the composer resize one of these three.
    const observer = new ResizeObserver(updateLayoutVariables);
    observer.observe(root);
    observer.observe(anchor);
    observer.observe(composer);
    return () => {
      observer.disconnect();
      clearLayoutVariables();
    };
  }, [panelRef]);
}
