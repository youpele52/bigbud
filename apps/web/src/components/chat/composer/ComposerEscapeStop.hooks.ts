import { type RefObject, useEffect, useRef, useState } from "react";

import { closestChatScope, hasOpenChatModal, resolveKeyboardChatScope } from "~/lib/chatFocus";
import { isTerminalFocused } from "~/lib/terminalFocus";
import { useCommandPaletteStore } from "~/stores/ui";

import {
  classifyEscapeStopKey,
  ESCAPE_STOP_WINDOW_MS,
  isEscapeLayerOpen,
  isFocusInEscapeSurface,
  resolveEscapeStopPress,
} from "./ComposerEscapeStop.logic";

/** Whether this composer's chat scope owns the keyboard and nothing else is waiting on Escape. */
function ownsEscapePress(anchor: HTMLElement | null): boolean {
  const scope = closestChatScope(anchor);
  return (
    scope !== null &&
    scope === resolveKeyboardChatScope() &&
    !isTerminalFocused() &&
    !isFocusInEscapeSurface() &&
    !hasOpenChatModal() &&
    !useCommandPaletteStore.getState().open &&
    !isEscapeLayerOpen()
  );
}

/**
 * Pressing Escape twice stops the thread via `onStop` while `enabled` (the Stop button is shown).
 *
 * The listener only observes: it never prevents or stops Escape, so single presses keep their
 * existing meaning. A press counts only if it reaches the window unconsumed. That is checked after
 * dispatch, so listener registration order cannot hide a later handler's preventDefault. Any other
 * key or pointer press between the two Escapes resets the gesture.
 */
export function useComposerEscapeStop(input: {
  readonly enabled: boolean;
  readonly anchorRef: RefObject<HTMLElement | null>;
  readonly onStop: () => void;
}): { readonly hintVisible: boolean } {
  const { anchorRef, enabled, onStop } = input;
  const onStopRef = useRef(onStop);
  const [hintVisible, setHintVisible] = useState(false);

  useEffect(() => {
    onStopRef.current = onStop;
  }, [onStop]);

  useEffect(() => {
    if (!enabled) return;
    let armedAt: number | null = null;
    let lastResetAt: number | null = null;
    let hintTimer: number | undefined;
    const pendingTimers = new Set<number>();
    const reachedWindow = new WeakSet<KeyboardEvent>();

    const hideHint = () => {
      window.clearTimeout(hintTimer);
      setHintVisible(false);
    };
    const disarm = () => {
      armedAt = null;
      hideHint();
    };
    const arm = (at: number) => {
      armedAt = at;
      window.clearTimeout(hintTimer);
      // The hint lives for what is left of the window measured from the press itself. The timer
      // only hides the hint; expiry and resets are judged from event timestamps, so a busy main
      // thread delaying any timer can never change the outcome of a press.
      const remaining = at + ESCAPE_STOP_WINDOW_MS - performance.now();
      const resetSincePress = lastResetAt !== null && lastResetAt >= at;
      if (remaining <= 0 || resetSincePress) {
        setHintVisible(false);
        return;
      }
      hintTimer = window.setTimeout(hideHint, remaining);
      setHintVisible(true);
    };
    // Other keys and pointer presses (e.g. clicking another thread) reset a pending first press.
    const reset = (at: number) => {
      lastResetAt = at;
      if (armedAt !== null) disarm();
    };

    const onKeyDownCapture = (event: KeyboardEvent) => {
      const kind = classifyEscapeStopKey(event);
      if (kind === "ignore") return;
      if (kind === "other") {
        reset(event.timeStamp);
        return;
      }
      // Snapshot before any handler runs: overlays may close themselves during dispatch.
      const owned = ownsEscapePress(anchorRef.current);
      const at = event.timeStamp;
      const timer = window.setTimeout(() => {
        pendingTimers.delete(timer);
        if (!owned || event.defaultPrevented || !reachedWindow.has(event)) {
          disarm();
          return;
        }
        if (resolveEscapeStopPress({ armedAt, lastResetAt, now: at }) === "stop") {
          disarm();
          onStopRef.current();
          return;
        }
        arm(at);
      }, 0);
      pendingTimers.add(timer);
    };
    const onKeyDownBubble = (event: KeyboardEvent) => {
      reachedWindow.add(event);
    };
    const onPointerDownCapture = (event: PointerEvent) => {
      reset(event.timeStamp);
    };

    window.addEventListener("keydown", onKeyDownCapture, { capture: true });
    window.addEventListener("keydown", onKeyDownBubble);
    window.addEventListener("pointerdown", onPointerDownCapture, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDownCapture, { capture: true });
      window.removeEventListener("keydown", onKeyDownBubble);
      window.removeEventListener("pointerdown", onPointerDownCapture, { capture: true });
      for (const timer of pendingTimers) window.clearTimeout(timer);
      window.clearTimeout(hintTimer);
      setHintVisible(false);
    };
  }, [anchorRef, enabled]);

  return { hintVisible };
}
