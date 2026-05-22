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
    const api = readNativeApi();
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!api || !terminal || !fitAddon) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const frame = window.requestAnimationFrame(() => {
      fitAddon.fit();
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: terminal.cols,
          rows: terminal.rows,
        })
        .catch(() => undefined);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [drawerHeight, resizeEpoch, terminalId, threadId]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden rounded-[4px]" />
  );
}
