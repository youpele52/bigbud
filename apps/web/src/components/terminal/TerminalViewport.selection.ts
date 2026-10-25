import type { Terminal } from "@xterm/xterm";
import type { MutableRefObject } from "react";
import {
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
} from "./ThreadTerminalDrawer.logic";
import { showTerminalSelectionAction } from "./TerminalViewport.session.helpers";

/** Keep selection gesture lifetime aligned with the viewport, not with its PTY process. */
export function attachTerminalSelection(
  input: Parameters<typeof showTerminalSelectionAction>[0] & {
    terminal: Terminal;
    mount: HTMLDivElement;
    disposed: () => boolean;
    selectionGestureActiveRef: MutableRefObject<boolean>;
  },
): () => void {
  const selection = input.terminal.onSelectionChange(() => {
    if (!input.terminalRef.current?.hasSelection()) input.clearSelectionAction();
  });
  const handleMouseUp = (event: MouseEvent) => {
    const shouldHandle = shouldHandleTerminalSelectionMouseUp(
      input.selectionGestureActiveRef.current,
      event.button,
    );
    input.selectionGestureActiveRef.current = false;
    if (!shouldHandle) return;
    input.selectionPointerRef.current = { x: event.clientX, y: event.clientY };
    input.selectionActionTimerRef.current = window.setTimeout(() => {
      if (input.disposed() || input.terminalRef.current !== input.terminal) return;
      input.selectionActionTimerRef.current = null;
      window.requestAnimationFrame(() => {
        if (!input.disposed() && input.terminalRef.current === input.terminal)
          void showTerminalSelectionAction(input);
      });
    }, terminalSelectionActionDelayForClickCount(event.detail));
  };
  const handlePointerDown = (event: PointerEvent) => {
    input.clearSelectionAction();
    input.selectionGestureActiveRef.current = event.button === 0;
  };
  window.addEventListener("mouseup", handleMouseUp);
  input.mount.addEventListener("pointerdown", handlePointerDown);
  return () => {
    selection.dispose();
    window.removeEventListener("mouseup", handleMouseUp);
    input.mount.removeEventListener("pointerdown", handlePointerDown);
  };
}
