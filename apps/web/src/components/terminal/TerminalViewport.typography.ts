import { useEffect, type MutableRefObject, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import {
  fitTerminalViewport,
  resizeServerTerminal,
  hasUsableTerminalViewportSize,
  waitForBundledTerminalFont,
} from "./TerminalViewport.session.helpers";

/** Typography updates preserve the emulator, selection and PTY identity. */
export function useTerminalTypography(input: {
  containerRef: RefObject<HTMLDivElement | null>;
  visible: boolean;
  serverReady: boolean;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  threadId: ThreadId;
  terminalId: string;
  terminalFontFamily: string;
  terminalFontSize: number;
  usesBundledTerminalFont: boolean;
}): void {
  const {
    containerRef,
    visible,
    serverReady,
    terminalRef,
    fitAddonRef,
    threadId,
    terminalId,
    terminalFontFamily,
    terminalFontSize,
    usesBundledTerminalFont,
  } = input;
  useEffect(() => {
    let cancelled = false;
    const terminal = terminalRef.current;
    const mount = containerRef.current;
    let pendingFit = false;
    let frame: number | null = null;
    const scheduleFit = () => {
      if (!pendingFit || frame !== null || !visible) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (
          cancelled ||
          !terminal ||
          terminalRef.current !== terminal ||
          document.visibilityState === "hidden" ||
          !hasUsableTerminalViewportSize(containerRef)
        )
          return;
        if (fitTerminalViewport({ containerRef, terminalRef, fitAddonRef }) && serverReady) {
          resizeServerTerminal({ terminalRef, threadId, terminalId });
        }
        terminal.refresh(0, terminal.rows - 1);
        pendingFit = false;
      });
    };
    const observer = new ResizeObserver(scheduleFit);
    if (mount) observer.observe(mount);
    document.addEventListener("visibilitychange", scheduleFit);
    void waitForBundledTerminalFont({ usesBundledTerminalFont, terminalFontSize }).then(() => {
      if (cancelled || !terminal || terminalRef.current !== terminal) return;
      terminal.options.fontFamily = terminalFontFamily;
      terminal.options.fontSize = terminalFontSize;
      pendingFit = true;
      scheduleFit();
    });
    return () => {
      cancelled = true;
      observer.disconnect();
      document.removeEventListener("visibilitychange", scheduleFit);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [
    containerRef,
    visible,
    serverReady,
    terminalRef,
    fitAddonRef,
    threadId,
    terminalId,
    terminalFontFamily,
    terminalFontSize,
    usesBundledTerminalFont,
  ]);
}
