import { type CSSProperties, useCallback, useLayoutEffect } from "react";
import { create } from "zustand";

import { CHAT_FLOATING_PANEL_STAGGER_PX } from "./chatFloatingPanel.layout";

/**
 * Stacking order for the panels floating over the chat messages area (Tasks and Sidecar).
 *
 * The most recently opened or interacted-with panel renders on top, window-like. Layers stay in
 * the `z-30` family so dialogs, menus and toasts (`z-50`) remain above every floating panel.
 */
export type ChatFloatingPanelId = "tasks" | "sidecar";

const CHAT_FLOATING_PANEL_BASE_Z_INDEX = 30;

interface ChatFloatingPanelOrderState {
  /** Open panels, back-to-front: the last entry is the topmost panel. */
  order: readonly ChatFloatingPanelId[];
  bringToFront: (panelId: ChatFloatingPanelId) => void;
  remove: (panelId: ChatFloatingPanelId) => void;
}

export const useChatFloatingPanelOrderStore = create<ChatFloatingPanelOrderState>((set) => ({
  order: [],
  bringToFront: (panelId) =>
    set((state) =>
      state.order.at(-1) === panelId
        ? state
        : { order: [...state.order.filter((entry) => entry !== panelId), panelId] },
    ),
  remove: (panelId) =>
    set((state) =>
      state.order.includes(panelId)
        ? { order: state.order.filter((entry) => entry !== panelId) }
        : state,
    ),
}));

/**
 * Whether a panel is staggered down-left so the other open panel's edge stays visible and
 * clickable. The Sidecar takes the offset whenever both are open, whatever the stacking order, so
 * nothing moves when a panel is brought to the front. (Cascade alternative: `order.at(-1) === id`.)
 */
function isChatFloatingPanelStaggered(
  order: readonly ChatFloatingPanelId[],
  panelId: ChatFloatingPanelId,
): boolean {
  return order.length > 1 && panelId === "sidecar";
}

export interface ChatFloatingPanelLayer {
  onFocusCapture: () => void;
  onPointerDownCapture: () => void;
  /** `zIndex` plus `--chat-floating-panel-stagger`, the offset the panel's placement applies. */
  style: CSSProperties;
}

/**
 * Raises the panel when it mounts (opens) and whenever the user presses or focuses inside it, and
 * drops it from the order when it unmounts (closes or minimizes). Spread the result onto the
 * panel's positioned element.
 */
export function useChatFloatingPanelLayer(panelId: ChatFloatingPanelId): ChatFloatingPanelLayer {
  const bringToFront = useChatFloatingPanelOrderStore((state) => state.bringToFront);
  const remove = useChatFloatingPanelOrderStore((state) => state.remove);
  const index = useChatFloatingPanelOrderStore((state) => state.order.indexOf(panelId));
  const staggered = useChatFloatingPanelOrderStore((state) =>
    isChatFloatingPanelStaggered(state.order, panelId),
  );
  const raise = useCallback(() => bringToFront(panelId), [bringToFront, panelId]);

  useLayoutEffect(() => {
    raise();
    return () => remove(panelId);
  }, [panelId, raise, remove]);

  return {
    onFocusCapture: raise,
    onPointerDownCapture: raise,
    style: {
      zIndex: CHAT_FLOATING_PANEL_BASE_Z_INDEX + Math.max(0, index),
      ["--chat-floating-panel-stagger" as string]: `${staggered ? CHAT_FLOATING_PANEL_STAGGER_PX : 0}px`,
    },
  };
}
