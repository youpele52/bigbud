/**
 * Double-Escape stop rules for the chat composer. A second unconsumed Escape inside the window
 * stops the thread exactly like the visible Stop button; any other key disarms it.
 */

export const ESCAPE_STOP_WINDOW_MS = 500;

/**
 * Open surfaces whose Escape must never count toward a stop. Mark overlays that close on Escape
 * without calling preventDefault (or ignore Escape) with `data-escape-layer="true"`.
 */
const ESCAPE_LAYER_SELECTOR = '[data-escape-layer="true"], [data-chat-cite-toolbar]';

/** Focusable surfaces that close on Escape without preventDefault while focus is inside them. */
const FOCUSED_ESCAPE_SURFACE_SELECTOR = '[data-slot="toast-popup"]';

type EscapeKeyFields = Pick<
  KeyboardEvent,
  "key" | "keyCode" | "repeat" | "isComposing" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
>;

export type EscapeStopKeyKind = "escape" | "ignore" | "other";

/** Bare Escape presses count; auto-repeat is ignored; IME, modified Escapes and other keys disarm. */
export function classifyEscapeStopKey(event: EscapeKeyFields): EscapeStopKeyKind {
  if (event.key !== "Escape") return "other";
  if (event.repeat) return "ignore";
  // Safari reports the Escape that cancels an IME composition with keyCode 229 after it ends.
  if (event.isComposing || event.keyCode === 229) return "other";
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return "other";
  return "escape";
}

export function isEscapeLayerOpen(documentRef: Document = document): boolean {
  return documentRef.querySelector(ESCAPE_LAYER_SELECTOR) !== null;
}

export function isFocusInEscapeSurface(documentRef: Document = document): boolean {
  return documentRef.activeElement?.closest(FOCUSED_ESCAPE_SURFACE_SELECTOR) != null;
}

export type EscapeStopPress = "arm" | "stop";

/**
 * Decides what an unconsumed Escape at `now` does, given when the previous one armed and when the
 * last other key or pointer press reset it. All values are event timestamps, so the outcome does
 * not depend on when a busy main thread gets around to handling each event.
 */
export function resolveEscapeStopPress(input: {
  readonly armedAt: number | null;
  readonly lastResetAt: number | null;
  readonly now: number;
  readonly windowMs?: number;
}): EscapeStopPress {
  const { armedAt, lastResetAt, now, windowMs = ESCAPE_STOP_WINDOW_MS } = input;
  if (armedAt === null || now < armedAt || now - armedAt > windowMs) return "arm";
  const resetBetween = lastResetAt !== null && lastResetAt >= armedAt && lastResetAt <= now;
  return resetBetween ? "arm" : "stop";
}
