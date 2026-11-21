/**
 * Whether a thread route was opened by the user or restored by startup.
 *
 * Marking the one non-explicit entry (startup restoration, or launching on a thread URL) is more
 * robust than marking every navigation call site: every other route entry (clicks, menus,
 * palettes, keybindings, notifications, links) is a user action. The thread remote-target gate
 * only auto-reconnects on explicit navigation, never at startup or in the background.
 */
export type ThreadNavigationIntent = "explicit" | "restored";

const restoredThreadIds = new Set<string>();

export function markRestoredThreadRoute(threadId: string) {
  restoredThreadIds.add(threadId);
}

/** Reads without clearing (safe across React's double render); clear when the visit ends. */
export function peekThreadNavigationIntent(threadId: string): ThreadNavigationIntent {
  return restoredThreadIds.has(threadId) ? "restored" : "explicit";
}

export function clearRestoredThreadRoute(threadId: string) {
  restoredThreadIds.delete(threadId);
}

/** Returns `"restored"` once for a restored route, then `"explicit"`. */
export function consumeThreadNavigationIntent(threadId: string): ThreadNavigationIntent {
  const intent = peekThreadNavigationIntent(threadId);
  clearRestoredThreadRoute(threadId);
  return intent;
}
