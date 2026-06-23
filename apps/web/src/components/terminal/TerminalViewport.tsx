import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  type ExecutionTargetId,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@bigbud/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { canTerminalAutoFocus } from "~/lib/terminalFocus";
import { readNativeApi } from "../../rpc/nativeApi";
import { useSettings } from "../../hooks/useSettings";
import { terminalFontFamilyFromSettings } from "./terminalTypography";
import { useTerminalKeybindings } from "./TerminalViewport.keybindings";
import { useTerminalViewportSession } from "./TerminalViewport.session";

export interface TerminalViewportProps {
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  executionTargetId?: ExecutionTargetId | undefined;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  drawerHeight: number;
  keybindings: ResolvedKeybindingsConfig;
}

interface FitTerminalViewportInput {
  container: Pick<HTMLDivElement, "getBoundingClientRect"> | null;
  terminal: Pick<Terminal, "buffer" | "scrollToBottom"> | null;
  fitAddon: Pick<FitAddon, "fit"> | null;
  requestTerminalResize: () => void;
}

export function fitTerminalViewport(input: FitTerminalViewportInput): void {
  const { container, terminal, fitAddon, requestTerminalResize } = input;
  if (!terminal || !fitAddon || !container) return;

  const { width, height } = container.getBoundingClientRect();
  if (width < 32 || height < 32) {
    return;
  }

  const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
  fitAddon.fit();
  if (wasAtBottom) {
    terminal.scrollToBottom();
  }
  requestTerminalResize();
}

export function TerminalViewport({
  threadId,
  terminalId,
  terminalLabel,
  executionTargetId,
  cwd,
  worktreePath,
  runtimeEnv,
  onSessionExited,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  drawerHeight,
  keybindings,
}: TerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const hasHandledExitRef = useRef(false);
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const lastAppliedTerminalEventIdRef = useRef(0);
  const terminalHydratedRef = useRef(false);
  const resizeRequestStateRef = useRef({ inFlight: false, pending: false });
  const handleSessionExited = useEffectEvent(() => {
    onSessionExited();
  });
  const handleAddTerminalContext = useEffectEvent((selection: TerminalContextSelection) => {
    onAddTerminalContext(selection);
  });
  const readTerminalLabel = useEffectEvent(() => terminalLabel);
  const settings = useSettings();
  const terminalFontFamily = terminalFontFamilyFromSettings(settings.terminalFontFamily);
  const terminalFontSize = settings.terminalFontSize;
  const usesBundledTerminalFont = settings.terminalFontFamily === "meslo-nerd-font-mono";

  // autoFocus and worktreePath are read at mount / specific moments only.
  // They are stored in refs so their current values are accessible without
  // being listed as deps that would cause terminal teardown/recreation.
  const autoFocusRef = useRef(autoFocus);
  const worktreePathRef = useRef(worktreePath);
  // Keep refs in sync without triggering effects
  autoFocusRef.current = autoFocus;
  worktreePathRef.current = worktreePath;

  useTerminalKeybindings({
    terminalRef,
    threadId,
    terminalId,
    keybindings,
  });

  useTerminalViewportSession({
    containerRef,
    terminalRef,
    fitAddonRef,
    hasHandledExitRef,
    selectionPointerRef,
    selectionGestureActiveRef,
    selectionActionRequestIdRef,
    selectionActionOpenRef,
    selectionActionTimerRef,
    lastAppliedTerminalEventIdRef,
    terminalHydratedRef,
    autoFocusRef,
    worktreePathRef,
    threadId,
    terminalId,
    readTerminalLabel,
    executionTargetId,
    cwd,
    runtimeEnv,
    terminalFontFamily,
    terminalFontSize,
    usesBundledTerminalFont,
    onSessionExited: handleSessionExited,
    onAddTerminalContext: handleAddTerminalContext,
  });

  useEffect(() => {
    resizeRequestStateRef.current = { inFlight: false, pending: false };
  }, [terminalId, threadId]);

  const requestTerminalResize = useEffectEvent(() => {
    const api = readNativeApi();
    const terminal = terminalRef.current;
    if (!api || !terminal) return;
    if (resizeRequestStateRef.current.inFlight) {
      resizeRequestStateRef.current.pending = true;
      return;
    }
    resizeRequestStateRef.current.inFlight = true;
    resizeRequestStateRef.current.pending = false;
    void api.terminal
      .resize({
        threadId,
        terminalId,
        cols: terminal.cols,
        rows: terminal.rows,
      })
      .catch(() => undefined)
      .finally(() => {
        resizeRequestStateRef.current.inFlight = false;
        if (!resizeRequestStateRef.current.pending) {
          return;
        }
        resizeRequestStateRef.current.pending = false;
        requestTerminalResize();
      });
  });

  const fitAndResizeTerminal = useEffectEvent(() => {
    fitTerminalViewport({
      container: containerRef.current,
      terminal: terminalRef.current,
      fitAddon: fitAddonRef.current,
      requestTerminalResize,
    });
  });

  useEffect(() => {
    if (!autoFocus) return;
    void focusRequestId;
    const terminal = terminalRef.current;
    if (!terminal || !canTerminalAutoFocus()) return;
    const frame = window.requestAnimationFrame(() => {
      if (!canTerminalAutoFocus()) return;
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId]);

  useEffect(() => {
    void drawerHeight;
    void resizeEpoch;
    const frame = window.requestAnimationFrame(() => {
      fitAndResizeTerminal();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [drawerHeight, resizeEpoch]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }

    let frame: number | null = null;
    let lastWidth = Math.round(container.getBoundingClientRect().width);
    let lastHeight = Math.round(container.getBoundingClientRect().height);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      const nextWidth = Math.round(entry.contentRect.width);
      const nextHeight = Math.round(entry.contentRect.height);
      if (nextWidth === lastWidth && nextHeight === lastHeight) {
        return;
      }

      lastWidth = nextWidth;
      lastHeight = nextHeight;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        fitAndResizeTerminal();
      });
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, []);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden rounded-[4px]" />
  );
}
