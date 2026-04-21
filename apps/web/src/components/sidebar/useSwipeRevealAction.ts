import { useCallback, useEffect, useRef, useState, type WheelEvent } from "react";

const REVEAL_WIDTH_PX = 44;
const OPEN_THRESHOLD_PX = 18;
const GESTURE_ACTIVATION_PX = 4;
const WHEEL_THRESHOLD_PX = 24;

interface PointerState {
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  moved: boolean;
}

interface UseSwipeRevealActionInput {
  itemId: string;
  disabled?: boolean;
}

export interface SwipeRevealActionState<TElement extends HTMLElement> {
  isDragging: boolean;
  isRevealed: boolean;
  revealOffset: number;
  isActionVisible: boolean;
  registerBoundaryElement: (element: HTMLElement | null) => void;
  resetReveal: () => void;
  openReveal: () => void;
  clearGestureClickSuppression: () => void;
  handlePointerDown: (event: React.PointerEvent<TElement>) => void;
  handlePointerMove: (event: React.PointerEvent<TElement>) => void;
  handlePointerUp: (event: React.PointerEvent<TElement>) => void;
  handlePointerCancel: (event: React.PointerEvent<TElement>) => void;
  handleWheel: (event: WheelEvent<TElement>) => void;
  consumeGestureClickSuppression: () => boolean;
}

export function useSwipeRevealAction<TElement extends HTMLElement>({
  itemId,
  disabled = false,
}: UseSwipeRevealActionInput): SwipeRevealActionState<TElement> {
  const [isDragging, setIsDragging] = useState(false);
  const [revealOffset, setRevealOffset] = useState(0);
  const [isRevealed, setIsRevealed] = useState(false);
  const lastItemIdRef = useRef<string | null>(null);
  const suppressClickAfterGestureRef = useRef(false);
  const wheelDeltaRef = useRef(0);
  const wheelResetTimeoutRef = useRef<number | null>(null);
  const pointerStateRef = useRef<PointerState | null>(null);
  const rootElementRef = useRef<TElement | null>(null);
  const boundaryElementRef = useRef<HTMLElement | null>(null);
  const revealOffsetRef = useRef(0);

  const setRevealPosition = useCallback((nextOffset: number) => {
    revealOffsetRef.current = nextOffset;
    setRevealOffset(nextOffset);
  }, []);

  const resetReveal = useCallback(() => {
    setIsDragging(false);
    setRevealPosition(0);
    setIsRevealed(false);
  }, [setRevealPosition]);

  const registerBoundaryElement = useCallback((element: HTMLElement | null) => {
    boundaryElementRef.current = element;
  }, []);

  const openReveal = useCallback(() => {
    setIsDragging(false);
    setRevealPosition(-REVEAL_WIDTH_PX);
    setIsRevealed(true);
  }, [setRevealPosition]);

  useEffect(() => {
    if (lastItemIdRef.current === itemId) {
      return;
    }
    lastItemIdRef.current = itemId;
    resetReveal();
  }, [itemId, resetReveal]);

  useEffect(() => {
    return () => {
      if (wheelResetTimeoutRef.current !== null) {
        window.clearTimeout(wheelResetTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isRevealed) {
      return;
    }

    const handlePointerDownOutside = (event: globalThis.PointerEvent) => {
      const boundaryElement = boundaryElementRef.current ?? rootElementRef.current;
      if (!boundaryElement) {
        resetReveal();
        return;
      }
      if (event.target instanceof Node && boundaryElement.contains(event.target)) {
        return;
      }
      resetReveal();
    };

    window.addEventListener("pointerdown", handlePointerDownOutside, true);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDownOutside, true);
    };
  }, [isRevealed, resetReveal]);

  const finishPointerGesture = useCallback(
    (pointerId?: number) => {
      const pointerState = pointerStateRef.current;
      if (!pointerState) {
        return false;
      }
      if (pointerId !== undefined && pointerState.pointerId !== pointerId) {
        return false;
      }

      pointerStateRef.current = null;
      if (pointerState.dragging || pointerState.moved) {
        suppressClickAfterGestureRef.current = true;
        if (revealOffsetRef.current <= -OPEN_THRESHOLD_PX) {
          openReveal();
        } else {
          resetReveal();
        }
      }
      return pointerState.dragging || pointerState.moved;
    },
    [openReveal, resetReveal],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<TElement>) => {
      if (disabled || event.button !== 0) {
        return;
      }

      rootElementRef.current = event.currentTarget;

      pointerStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dragging: false,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [disabled],
  );

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<TElement>) => {
      if (disabled) {
        return;
      }

      const pointerState = pointerStateRef.current;
      if (!pointerState || pointerState.pointerId !== event.pointerId) {
        return;
      }

      const deltaX = event.clientX - pointerState.startX;
      const deltaY = event.clientY - pointerState.startY;

      if (!pointerState.dragging) {
        if (deltaX > -GESTURE_ACTIVATION_PX || Math.abs(deltaX) <= Math.abs(deltaY)) {
          return;
        }
        pointerState.dragging = true;
        setIsDragging(true);
      }

      event.preventDefault();
      pointerState.moved = true;
      const nextOffset = -Math.min(REVEAL_WIDTH_PX, Math.max(0, -deltaX));
      setRevealPosition(nextOffset);
    },
    [disabled, setRevealPosition],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<TElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      finishPointerGesture(event.pointerId);
    },
    [finishPointerGesture],
  );

  const handlePointerCancel = useCallback(
    (event: React.PointerEvent<TElement>) => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      finishPointerGesture(event.pointerId);
    },
    [finishPointerGesture],
  );

  const handleWheel = useCallback(
    (event: WheelEvent<TElement>) => {
      if (disabled) {
        return;
      }
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || event.deltaX === 0) {
        return;
      }

      event.preventDefault();
      wheelDeltaRef.current += event.deltaX;

      if (wheelResetTimeoutRef.current !== null) {
        window.clearTimeout(wheelResetTimeoutRef.current);
      }
      wheelResetTimeoutRef.current = window.setTimeout(() => {
        wheelDeltaRef.current = 0;
        wheelResetTimeoutRef.current = null;
      }, 150);

      if (!isRevealed && wheelDeltaRef.current <= -WHEEL_THRESHOLD_PX) {
        openReveal();
        wheelDeltaRef.current = 0;
        return;
      }
    },
    [disabled, isRevealed, openReveal],
  );

  const consumeGestureClickSuppression = useCallback(() => {
    if (!suppressClickAfterGestureRef.current) {
      return false;
    }
    suppressClickAfterGestureRef.current = false;
    return true;
  }, []);

  const clearGestureClickSuppression = useCallback(() => {
    suppressClickAfterGestureRef.current = false;
  }, []);

  return {
    isDragging,
    isRevealed,
    revealOffset,
    isActionVisible: isRevealed || revealOffset < 0,
    registerBoundaryElement,
    resetReveal,
    openReveal,
    clearGestureClickSuppression,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
    handleWheel,
    consumeGestureClickSuppression,
  };
}
