import { useEffect, type MutableRefObject, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { ThreadId } from "@bigbud/contracts/core/baseSchemas";
import {
  fitTerminalViewport,
  resizeServerTerminal,
  hasUsableTerminalViewportSize,
} from "./TerminalViewport.session.helpers";
import type { TerminalFontController, TerminalTypographySettings } from "./TerminalFontController";

/** Typography updates preserve the emulator and PTY identity. */
export function useTerminalTypography(
  input: TerminalTypographySettings & {
    containerRef: RefObject<HTMLDivElement | null>;
    visible: boolean;
    serverReady: boolean;
    terminalRef: MutableRefObject<Terminal | null>;
    fitAddonRef: MutableRefObject<FitAddon | null>;
    threadId: ThreadId;
    terminalId: string;
    cwd: string;
    executionTargetId?: string | undefined;
    runtimeEnv?: Record<string, string> | undefined;
    fontControllerRef: MutableRefObject<TerminalFontController | null>;
  },
): void {
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
    bundledTerminalFont,
    terminalLineHeight,
    fontControllerRef,
    cwd,
    executionTargetId,
    runtimeEnv,
  } = input;
  useEffect(() => {
    let cancelled = false;
    const terminal = terminalRef.current;
    const fontController = fontControllerRef.current;
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
    const onApplied = () => {
      if (cancelled || !terminal || terminalRef.current !== terminal) return;
      pendingFit = true;
      scheduleFit();
    };
    const unsubscribe = fontController?.onApplied(onApplied);
    void fontController
      ?.update({
        terminalFontFamily,
        terminalFontSize,
        terminalLineHeight,
        bundledTerminalFont,
      })
      .then(onApplied);
    return () => {
      cancelled = true;
      unsubscribe?.();
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
    bundledTerminalFont,
    terminalLineHeight,
    fontControllerRef,
    // These inputs can recreate a session even when its font choice stays the same.
    cwd,
    executionTargetId,
    runtimeEnv,
  ]);
}
