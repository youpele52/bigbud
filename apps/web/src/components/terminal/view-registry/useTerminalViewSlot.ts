import { useLayoutEffect, useRef, type RefObject } from "react";
import type { TerminalViewportProps } from "../TerminalViewport.types";
import {
  terminalViewKey,
  terminalViewRegistry,
  type TerminalViewBorrow,
} from "./TerminalViewRegistry";

/**
 * Borrows the registry's view of one pane for a slot element. Layout effects run before React
 * removes the slot, so a release moves the view to the parking holder while both are connected.
 */
export function useTerminalViewSlot(
  slotRef: RefObject<HTMLElement | null>,
  props: TerminalViewportProps,
  enabled: boolean,
): void {
  const propsRef = useRef(props);
  propsRef.current = props;
  const borrowRef = useRef<TerminalViewBorrow | null>(null);
  const key = terminalViewKey(props.threadId, props.terminalId);

  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!enabled || !slot) return;
    const borrow = terminalViewRegistry.acquire(slot, propsRef.current);
    borrowRef.current = borrow;
    return () => {
      if (borrowRef.current === borrow) borrowRef.current = null;
      borrow.release();
    };
  }, [enabled, key, slotRef]);

  useLayoutEffect(() => {
    borrowRef.current?.update(props);
  });
}
