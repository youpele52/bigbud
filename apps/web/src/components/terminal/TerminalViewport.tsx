import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  type ExecutionTargetId,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@bigbud/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { canTerminalAutoFocus } from "~/lib/terminalFocus";
import { isElectron } from "~/config/env";
import { readNativeApi } from "../../rpc/nativeApi";
import { useSettings } from "../../hooks/useSettings";
import { useComposerDraftStore, type AnnotationIntent } from "../../stores/composer";
import { makeAnnotationId } from "../files/FilesPanel.shared";
import { terminalFontFamilyFromSettings } from "./terminalTypography";
import { useTerminalKeybindings } from "./TerminalViewport.keybindings";
import { useTerminalViewportSession } from "./TerminalViewport.session";
import {
  TerminalViewportAnnotationComposer,
  type PendingTerminalAnnotation,
} from "./TerminalViewport.annotations";
import {
  acceptsTerminalDrop,
  pasteDroppedTerminalPaths,
  readDroppedTerminalPaths,
} from "./TerminalViewport.session.helpers";

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
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
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
  const dragDepthRef = useRef(0);
  const handleSessionExited = useEffectEvent(() => {
    onSessionExited();
  });
  const handleAddTerminalContext = useEffectEvent((selection: TerminalContextSelection) => {
    onAddTerminalContext(selection);
  });
  const [pendingAnnotation, setPendingAnnotation] = useState<PendingTerminalAnnotation | null>(
    null,
  );
  const [isDragOver, setIsDragOver] = useState(false);
  const handleRequestTerminalAnnotation = useEffectEvent(
    (input: {
      selection: TerminalContextSelection;
      position: { x: number; y: number };
      selectionRect: { left: number; top: number; right: number; bottom: number } | null;
    }) => {
      setPendingAnnotation({
        selection: input.selection,
        anchorX: input.position.x,
        anchorY: input.position.y,
        selectionRect: input.selectionRect,
      });
    },
  );
  const handleCreateTerminalAnnotation = useEffectEvent(
    (input: { intent: AnnotationIntent; comment: string; selection: TerminalContextSelection }) => {
      useComposerDraftStore.getState().addAnnotation(threadId, {
        id: makeAnnotationId(),
        kind: "terminal",
        comment: input.comment,
        intent: input.intent,
        createdAt: new Date().toISOString(),
        terminal: {
          terminalId: input.selection.terminalId,
          terminalLabel: input.selection.terminalLabel,
        },
        selection: {
          startLine: input.selection.lineStart,
          endLine: input.selection.lineEnd,
          text: input.selection.text,
        },
      });
      setPendingAnnotation(null);
    },
  );
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
    containerRef: mountRef,
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
    onRequestTerminalAnnotation: handleRequestTerminalAnnotation,
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
      container: mountRef.current,
      terminal: terminalRef.current,
      fitAddon: fitAddonRef.current,
      requestTerminalResize,
    });
  });
  const readNativeFilePath = useEffectEvent((file: File) =>
    isElectron ? (window.desktopBridge?.getFilePath(file) ?? "") : "",
  );
  const hasAcceptedDropData = useEffectEvent((event: React.DragEvent<HTMLDivElement>) =>
    acceptsTerminalDrop(Array.from(event.dataTransfer.types)),
  );
  const onDragEnter = useEffectEvent((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasAcceptedDropData(event)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  });
  const onDragOver = useEffectEvent((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasAcceptedDropData(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsDragOver(true);
  });
  const onDragLeave = useEffectEvent((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasAcceptedDropData(event)) {
      return;
    }
    event.preventDefault();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDragOver(false);
    }
  });
  const onDrop = useEffectEvent((event: React.DragEvent<HTMLDivElement>) => {
    if (!hasAcceptedDropData(event)) {
      return;
    }
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    const paths = readDroppedTerminalPaths({
      dataTransfer: event.dataTransfer,
      readNativeFilePath,
    });
    pasteDroppedTerminalPaths({
      terminal: terminalRef.current,
      paths,
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
    const container = wrapperRef.current;
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
    <div
      ref={wrapperRef}
      className={`relative h-full w-full overflow-hidden rounded-[4px] ${
        isDragOver ? "ring-1 ring-primary/45" : ""
      }`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div ref={mountRef} className="h-full w-full" />
      {pendingAnnotation ? (
        <TerminalViewportAnnotationComposer
          pendingAnnotation={pendingAnnotation}
          onCreateAnnotation={handleCreateTerminalAnnotation}
          onCancel={() => setPendingAnnotation(null)}
        />
      ) : null}
    </div>
  );
}
