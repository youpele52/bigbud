import { useLayoutEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";

const CARD_SELECTOR = '[data-slot="toast-popup"]';

function firstFocusableCard(viewport: HTMLElement) {
  return Array.from(viewport.querySelectorAll<HTMLElement>(CARD_SELECTOR)).find(
    (card) => !card.inert && !card.hasAttribute("data-ending-style"),
  );
}

// Base UI navigates its unfiltered store. Thread filtering can leave its chosen
// root unmounted, or keep focus on an exiting card when that root cannot focus.
export function useToastViewportFocus(hasVisibleToasts: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const lastFocusedInside = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (hasVisibleToasts) return;
    const win = window;
    function skipEmptyViewport(event: globalThis.KeyboardEvent) {
      // Base UI's window listener otherwise captures F6 and pauses all timers,
      // even though every notification belongs to a different thread. Leave the
      // native default intact, but do not let that listener enter an empty stack.
      if (event.key === "F6") event.stopImmediatePropagation();
    }
    win?.addEventListener("keydown", skipEmptyViewport, true);
    return () => win?.removeEventListener("keydown", skipEmptyViewport, true);
  }, [hasVisibleToasts]);

  useLayoutEffect(() => {
    const viewport = ref.current;
    if (!viewport) return;
    const active = viewport.ownerDocument.activeElement;
    const card = active?.closest<HTMLElement>(CARD_SELECTOR);
    const onExitingCard =
      card && viewport.contains(card) && (card.inert || card.hasAttribute("data-ending-style"));
    const lostFocus =
      lastFocusedInside.current &&
      (!lastFocusedInside.current.isConnected || !hasVisibleToasts) &&
      active === viewport.ownerDocument.body;
    if (!onExitingCard && !lostFocus && !(active === viewport && !hasVisibleToasts)) return;
    const target = firstFocusableCard(viewport) ?? previousFocus.current;
    lastFocusedInside.current = null;
    if (target?.isConnected) target.focus({ preventScroll: true });
  });

  return {
    ref,
    onFocusCapture(event: FocusEvent<HTMLDivElement>) {
      if (!event.currentTarget.contains(event.relatedTarget)) {
        const previous = event.relatedTarget;
        if (previous instanceof HTMLElement) previousFocus.current = previous;
      }
      lastFocusedInside.current = event.target;
    },
    onBlurCapture(event: FocusEvent<HTMLDivElement>) {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
        lastFocusedInside.current = null;
      }
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (event.key !== "Tab" || event.shiftKey || event.target !== event.currentTarget) return;
      const firstCard = firstFocusableCard(event.currentTarget);
      if (firstCard) {
        event.preventDefault();
        firstCard.focus({ preventScroll: true });
      }
    },
  };
}
