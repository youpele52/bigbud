/**
 * Shared placement for the panels that float over the chat messages area (Tasks and Sidecar).
 *
 * Both panels hang from the top of the messages area — the element marked with
 * `data-chat-floating-panel-anchor`, which sits below the chat header and any thread banners —
 * inset by `CHAT_FLOATING_PANEL_INSET_PX` (Tailwind `*-3`).
 */
export const CHAT_FLOATING_PANEL_ANCHOR_SELECTOR = "[data-chat-floating-panel-anchor]";

/** Gap between a floating panel and the edges it is anchored to; matches Tailwind `*-3`. */
export const CHAT_FLOATING_PANEL_INSET_PX = 12;

/**
 * Down-left offset of a staggered panel while both panels are open, so the panel beneath keeps a
 * visible, clickable edge. Panels read it from `--chat-floating-panel-stagger`.
 */
export const CHAT_FLOATING_PANEL_STAGGER_PX = 24;

/**
 * Tasks panel wrapper: docked to the bottom of the messages area on narrow viewports and to its
 * top-right corner from `sm` up.
 */
export const TASKS_FLOATING_PANEL_POSITION_CLASS_NAME =
  "pointer-events-none absolute inset-x-3 bottom-3 z-30 sm:inset-x-auto sm:top-3 sm:right-3 sm:bottom-auto";
