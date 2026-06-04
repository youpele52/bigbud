import { type ThreadId } from "@bigbud/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { clampDrawerHeight } from "./ThreadTerminalDrawer.logic";

const WINDOW_RESIZE_DEBOUNCE_MS = 100;

interface UseThreadTerminalDrawerResizeInput {
  height: number;
  threadId: ThreadId;
  visible: boolean;
  onHeightChange: (height: number) => void;
}

export function useThreadTerminalDrawerResize(input: UseThreadTerminalDrawerResizeInput) {
  const [drawerHeight, setDrawerHeight] = useState(() => clampDrawerHeight(input.height));
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const drawerHeightRef = useRef(drawerHeight);
  const lastSyncedHeightRef = useRef(clampDrawerHeight(input.height));
  const onHeightChangeRef = useRef(input.onHeightChange);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
  } | null>(null);
  const didResizeDuringDragRef = useRef(false);
  const resizeAnimationFrameRef = useRef<number | null>(null);
  const pendingDrawerHeightRef = useRef<number | null>(null);
  const windowResizeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    onHeightChangeRef.current = input.onHeightChange;
  }, [input.onHeightChange]);

  useEffect(() => {
    drawerHeightRef.current = drawerHeight;
  }, [drawerHeight]);

  const syncHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampDrawerHeight(nextHeight);
    if (lastSyncedHeightRef.current === clampedHeight) return;
    lastSyncedHeightRef.current = clampedHeight;
    onHeightChangeRef.current(clampedHeight);
  }, []);

  const scheduleDrawerHeight = useCallback((nextHeight: number) => {
    pendingDrawerHeightRef.current = nextHeight;
    if (resizeAnimationFrameRef.current !== null) {
      return;
    }
    resizeAnimationFrameRef.current = window.requestAnimationFrame(() => {
      resizeAnimationFrameRef.current = null;
      const pendingHeight = pendingDrawerHeightRef.current;
      pendingDrawerHeightRef.current = null;
      if (pendingHeight === null) {
        return;
      }
      setDrawerHeight(pendingHeight);
    });
  }, []);

  const flushScheduledDrawerHeight = useCallback(() => {
    if (resizeAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeAnimationFrameRef.current);
      resizeAnimationFrameRef.current = null;
    }
    const pendingHeight = pendingDrawerHeightRef.current;
    pendingDrawerHeightRef.current = null;
    if (pendingHeight !== null) {
      setDrawerHeight(pendingHeight);
    }
  }, []);

  useEffect(() => {
    const clampedHeight = clampDrawerHeight(input.height);
    setDrawerHeight(clampedHeight);
    drawerHeightRef.current = clampedHeight;
    lastSyncedHeightRef.current = clampedHeight;
  }, [input.height, input.threadId]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    didResizeDuringDragRef.current = false;
    resizeStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: drawerHeightRef.current,
    };
  }, []);

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      event.preventDefault();
      const clampedHeight = clampDrawerHeight(
        resizeState.startHeight + (resizeState.startY - event.clientY),
      );
      if (clampedHeight === drawerHeightRef.current) {
        return;
      }
      didResizeDuringDragRef.current = true;
      drawerHeightRef.current = clampedHeight;
      scheduleDrawerHeight(clampedHeight);
    },
    [scheduleDrawerHeight],
  );

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      if (!didResizeDuringDragRef.current) {
        return;
      }
      flushScheduledDrawerHeight();
      syncHeight(drawerHeightRef.current);
      setResizeEpoch((value) => value + 1);
    },
    [flushScheduledDrawerHeight, syncHeight],
  );

  useEffect(() => {
    if (!input.visible) {
      return;
    }

    const onWindowResize = () => {
      if (windowResizeTimerRef.current !== null) {
        window.clearTimeout(windowResizeTimerRef.current);
      }
      windowResizeTimerRef.current = window.setTimeout(() => {
        windowResizeTimerRef.current = null;
        const clampedHeight = clampDrawerHeight(drawerHeightRef.current);
        const changed = clampedHeight !== drawerHeightRef.current;
        if (changed) {
          setDrawerHeight(clampedHeight);
          drawerHeightRef.current = clampedHeight;
        }
        if (!resizeStateRef.current) {
          syncHeight(clampedHeight);
        }
        setResizeEpoch((value) => value + 1);
      }, WINDOW_RESIZE_DEBOUNCE_MS);
    };
    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
      if (windowResizeTimerRef.current !== null) {
        window.clearTimeout(windowResizeTimerRef.current);
        windowResizeTimerRef.current = null;
      }
    };
  }, [input.visible, syncHeight]);

  useEffect(() => {
    if (!input.visible) {
      return;
    }
    setResizeEpoch((value) => value + 1);
  }, [input.visible]);

  useEffect(() => {
    return () => {
      if (resizeAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeAnimationFrameRef.current);
      }
      if (windowResizeTimerRef.current !== null) {
        window.clearTimeout(windowResizeTimerRef.current);
      }
      syncHeight(drawerHeightRef.current);
    };
  }, [syncHeight]);

  return {
    drawerHeight,
    resizeEpoch,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerEnd,
  };
}
