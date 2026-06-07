import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef } from "react";

import {
  getRightPanelMaxWidth,
  useRightPanelWidthStore,
} from "~/stores/rightPanel/rightPanelWidth.store";

function disableTransitions(element: HTMLElement) {
  element.style.setProperty("transition-duration", "0s");
}

function restoreTransitions(element: HTMLElement) {
  element.style.removeProperty("transition-duration");
}

export function useRightPanelWidth() {
  const panelWidth = useRightPanelWidthStore((state) => state.panelWidth);
  const resizing = useRightPanelWidthStore((state) => state.resizing);
  const setPanelWidth = useRightPanelWidthStore((state) => state.setPanelWidth);
  const setResizing = useRightPanelWidthStore((state) => state.setResizing);
  const startRef = useRef<{ x: number; width: number } | null>(null);
  const transitionTargetsRef = useRef<HTMLElement[]>([]);

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();

      const handle = event.currentTarget;
      const container = handle.parentElement;
      const placeholder = container?.previousElementSibling as HTMLElement | null;
      const targets = [container, placeholder].filter(
        (el): el is HTMLElement => el !== null && el !== undefined,
      );
      targets.forEach(disableTransitions);
      transitionTargetsRef.current = targets;

      event.currentTarget.setPointerCapture(event.pointerId);
      setResizing(true);
      startRef.current = { x: event.clientX, width: panelWidth };
    },
    [panelWidth, setResizing],
  );

  useEffect(() => {
    if (!resizing) return;

    const onPointerMove = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      const delta = start.x - event.clientX;
      const nextWidth = Math.max(320, Math.min(getRightPanelMaxWidth(320), start.width + delta));
      setPanelWidth(nextWidth);
    };
    const onPointerUp = () => {
      transitionTargetsRef.current.forEach(restoreTransitions);
      transitionTargetsRef.current = [];
      setResizing(false);
      startRef.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      transitionTargetsRef.current.forEach(restoreTransitions);
      transitionTargetsRef.current = [];
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [resizing, setPanelWidth, setResizing]);

  return {
    onResizePointerDown,
    panelWidth,
  };
}
