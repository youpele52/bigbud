import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import {
  getLeftSidebarGapWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH_PX,
} from "../layout/chatLayout.shared";

interface UseRightPanelWidthOptions {
  minWidth: number;
  storageKey: string;
}

function getRightPanelMaxWidth(minWidth: number) {
  const viewportMaxWidth = Math.floor(window.innerWidth * 0.8);
  const sharedLayoutMaxWidth = Math.floor(
    window.innerWidth - getLeftSidebarGapWidth() - THREAD_MAIN_CONTENT_MIN_WIDTH_PX,
  );

  return Math.max(minWidth, Math.min(viewportMaxWidth, sharedLayoutMaxWidth));
}

function getRightPanelDefaultWidth(minWidth: number) {
  return Math.max(minWidth, Math.floor(window.innerWidth / 3));
}

export function useRightPanelWidth({ minWidth, storageKey }: UseRightPanelWidthOptions) {
  const [panelWidth, setPanelWidth] = useState(() => {
    const stored = getLocalStorageItem(storageKey, Schema.Finite);
    const max = getRightPanelMaxWidth(minWidth);
    return stored ? Math.max(minWidth, Math.min(max, stored)) : getRightPanelDefaultWidth(minWidth);
  });
  const [resizing, setResizing] = useState(false);
  const startRef = useRef<{ x: number; width: number } | null>(null);
  const pendingWidthRef = useRef(panelWidth);

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setResizing(true);
      startRef.current = { x: event.clientX, width: panelWidth };
    },
    [panelWidth],
  );

  useEffect(() => {
    const handleResize = () => {
      const max = getRightPanelMaxWidth(minWidth);
      setPanelWidth((currentWidth) => {
        if (currentWidth <= max) return currentWidth;
        const nextWidth = Math.max(minWidth, max);
        pendingWidthRef.current = nextWidth;
        return nextWidth;
      });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [minWidth]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const leftSidebarGap = document.querySelector<HTMLElement>(
      "[data-slot='sidebar'][data-side='left'] [data-slot='sidebar-gap']",
    );
    if (!leftSidebarGap) {
      return;
    }

    const observer = new ResizeObserver(() => {
      const max = getRightPanelMaxWidth(minWidth);
      setPanelWidth((currentWidth) => {
        const nextWidth = Math.min(currentWidth, max);
        pendingWidthRef.current = nextWidth;
        return nextWidth;
      });
    });
    observer.observe(leftSidebarGap);

    return () => {
      observer.disconnect();
    };
  }, [minWidth]);

  useEffect(() => {
    if (!resizing) return;

    const onPointerMove = (event: PointerEvent) => {
      const start = startRef.current;
      if (!start) return;
      const delta = start.x - event.clientX;
      const nextWidth = Math.max(
        minWidth,
        Math.min(getRightPanelMaxWidth(minWidth), start.width + delta),
      );
      setPanelWidth(nextWidth);
      pendingWidthRef.current = nextWidth;
    };
    const onPointerUp = () => {
      setResizing(false);
      startRef.current = null;
      setLocalStorageItem(storageKey, pendingWidthRef.current, Schema.Finite);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [minWidth, resizing, storageKey]);

  return {
    onResizePointerDown,
    panelWidth,
  };
}
