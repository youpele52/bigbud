import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  type ExecutionTargetId,
  type TerminalDropPathMode,
  type ThreadId,
} from "@bigbud/contracts";
import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { readNativeApi } from "../../rpc/nativeApi";
import { selectTerminalEventEntries, selectTerminalEventLastId } from "../../stores/terminal";
import { useTerminalStateStore } from "../../stores/terminal";
import {
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
  terminalThemeFromApp,
  writeSystemMessage,
} from "./ThreadTerminalDrawer.logic";
import { TerminalWriteBatcher } from "./TerminalWriteBatcher";
import { applyPendingTerminalEvents, makeApplyTerminalEvent } from "./TerminalViewport.events";
import { makeTerminalLinkProvider } from "./TerminalViewport.links";
import {
  clearSelectionAction,
  fitAndResizeServerTerminal,
  openTerminalSession,
  showTerminalSelectionAction,
  waitForBundledTerminalFont,
  writeTerminalOpenFailure,
} from "./TerminalViewport.session.helpers";

interface UseTerminalViewportSessionInput {
  containerRef: RefObject<HTMLDivElement | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  hasHandledExitRef: MutableRefObject<boolean>;
  selectionPointerRef: MutableRefObject<{ x: number; y: number } | null>;
  selectionGestureActiveRef: MutableRefObject<boolean>;
  selectionActionRequestIdRef: MutableRefObject<number>;
  selectionActionOpenRef: MutableRefObject<boolean>;
  selectionActionTimerRef: MutableRefObject<number | null>;
  lastAppliedTerminalEventIdRef: MutableRefObject<number>;
  terminalHydratedRef: MutableRefObject<boolean>;
  autoFocusRef: MutableRefObject<boolean>;
  worktreePathRef: MutableRefObject<string | null | undefined>;
  dropPathModeRef: MutableRefObject<TerminalDropPathMode>;
  threadId: ThreadId;
  terminalId: string;
  readTerminalLabel: () => string;
  executionTargetId?: ExecutionTargetId | undefined;
  cwd: string;
  runtimeEnv?: Record<string, string> | undefined;
  terminalFontFamily: string;
  terminalFontSize: number;
  usesBundledTerminalFont: boolean;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  onRequestTerminalAnnotation: (input: {
    selection: TerminalContextSelection;
    position: { x: number; y: number };
    selectionRect: { left: number; top: number; right: number; bottom: number } | null;
  }) => void;
}

export function useTerminalViewportSession(input: UseTerminalViewportSessionInput) {
  // Keep callbacks in refs so the session effect does not re-run (and
  // remount the terminal) when upstream function identities change.
  const readTerminalLabelRef = useRef(input.readTerminalLabel);
  readTerminalLabelRef.current = input.readTerminalLabel;
  const onAddTerminalContextRef = useRef(input.onAddTerminalContext);
  onAddTerminalContextRef.current = input.onAddTerminalContext;
  const onRequestTerminalAnnotationRef = useRef(input.onRequestTerminalAnnotation);
  onRequestTerminalAnnotationRef.current = input.onRequestTerminalAnnotation;
  const onSessionExitedRef = useRef(input.onSessionExited);
  onSessionExitedRef.current = input.onSessionExited;

  useEffect(() => {
    const mount = input.containerRef.current;
    if (!mount) return;

    const readTerminalLabel = () => readTerminalLabelRef.current();
    const onAddTerminalContext = (selection: TerminalContextSelection) =>
      onAddTerminalContextRef.current(selection);
    const onRequestTerminalAnnotation = (input: {
      selection: TerminalContextSelection;
      position: { x: number; y: number };
      selectionRect: { left: number; top: number; right: number; bottom: number } | null;
    }) => onRequestTerminalAnnotationRef.current(input);
    const terminalHydratedRef = input.terminalHydratedRef;
    const lastAppliedTerminalEventIdRef = input.lastAppliedTerminalEventIdRef;
    const selectionActionTimerRef = input.selectionActionTimerRef;
    const terminalRef = input.terminalRef;
    const fitAddonRef = input.fitAddonRef;
    const clearSelectionActionState = () =>
      clearSelectionAction({
        selectionActionRequestIdRef: input.selectionActionRequestIdRef,
        selectionActionTimerRef: input.selectionActionTimerRef,
      });

    let disposed = false;
    const fitAddon = new FitAddon();
    const writeBatcher = new TerminalWriteBatcher();
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1.2,
      fontSize: input.terminalFontSize,
      scrollback: 5_000,
      fontFamily: input.terminalFontFamily,
      theme: terminalThemeFromApp(),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);

    input.terminalRef.current = terminal;
    input.fitAddonRef.current = fitAddon;

    const api = readNativeApi();
    if (!api) {
      input.terminalRef.current = null;
      input.fitAddonRef.current = null;
      terminal.dispose();
      writeBatcher.dispose();
      return;
    }

    const terminalLinksDisposable = terminal.registerLinkProvider(
      makeTerminalLinkProvider({ terminalRef: input.terminalRef, cwd: input.cwd, api }),
    );
    const inputDisposable = terminal.onData((data) => {
      void api.terminal
        .write({ threadId: input.threadId, terminalId: input.terminalId, data })
        .catch((err) =>
          writeSystemMessage(
            terminal,
            err instanceof Error ? err.message : "Terminal write failed",
          ),
        );
    });
    const selectionDisposable = terminal.onSelectionChange(() => {
      if (input.terminalRef.current?.hasSelection()) {
        return;
      }
      clearSelectionActionState();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        input.selectionGestureActiveRef.current,
        event.button,
      );
      input.selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      input.selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      input.selectionActionTimerRef.current = window.setTimeout(() => {
        input.selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void showTerminalSelectionAction({
            containerRef: input.containerRef,
            terminalRef: input.terminalRef,
            selectionPointerRef: input.selectionPointerRef,
            selectionActionRequestIdRef: input.selectionActionRequestIdRef,
            selectionActionOpenRef: input.selectionActionOpenRef,
            selectionActionTimerRef: input.selectionActionTimerRef,
            terminalId: input.terminalId,
            clearSelectionAction: clearSelectionActionState,
            onAddTerminalContext,
            onRequestTerminalAnnotation,
            readTerminalLabel,
          });
        });
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionActionState();
      input.selectionGestureActiveRef.current = event.button === 0;
    };
    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = input.terminalRef.current;
      if (!activeTerminal) return;
      activeTerminal.options.theme = terminalThemeFromApp();
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const applyTerminalEvent = makeApplyTerminalEvent({
      terminalRef: input.terminalRef,
      hasHandledExitRef: input.hasHandledExitRef,
      dropPathModeRef: input.dropPathModeRef,
      writeBatcher,
      clearSelectionAction: clearSelectionActionState,
      handleSessionExited: () => onSessionExitedRef.current(),
    });
    const unsubscribeTerminalEvents = useTerminalStateStore.subscribe((state, previousState) => {
      if (!terminalHydratedRef.current) {
        return;
      }
      const previousLastEntryId = selectTerminalEventLastId(
        previousState.terminalEventLastIdsByKey,
        input.threadId,
        input.terminalId,
      );
      const nextLastEntryId = selectTerminalEventLastId(
        state.terminalEventLastIdsByKey,
        input.threadId,
        input.terminalId,
      );
      if (nextLastEntryId === previousLastEntryId) {
        return;
      }
      const nextEntries = selectTerminalEventEntries(
        state.terminalEventEntriesByKey,
        input.threadId,
        input.terminalId,
      );
      applyPendingTerminalEvents({
        terminalEventEntries: nextEntries,
        lastAppliedTerminalEventIdRef,
        applyTerminalEvent,
      });
    });

    let initialFitResizeTimer: number | null = null;
    let openTerminalRetryTimer: number | null = null;
    const runOpenTerminal = async () => {
      try {
        const opened = await openTerminalSession({
          disposed: () => disposed,
          terminalRef: input.terminalRef,
          fitAddonRef: input.fitAddonRef,
          writeBatcher,
          threadId: input.threadId,
          terminalId: input.terminalId,
          executionTargetId: input.executionTargetId,
          cwd: input.cwd,
          runtimeEnv: input.runtimeEnv,
          worktreePathRef: input.worktreePathRef,
          dropPathModeRef: input.dropPathModeRef,
          usesBundledTerminalFont: input.usesBundledTerminalFont,
          terminalFontSize: input.terminalFontSize,
          applyTerminalEvent,
          lastAppliedTerminalEventIdRef: input.lastAppliedTerminalEventIdRef,
          terminalHydratedRef: input.terminalHydratedRef,
          autoFocusRef: input.autoFocusRef,
          containerRef: input.containerRef,
        });
        if (!opened) {
          openTerminalRetryTimer = window.setTimeout(() => {
            openTerminalRetryTimer = null;
            void runOpenTerminal();
          }, 50);
        }
      } catch (err) {
        if (disposed) return;
        writeTerminalOpenFailure(terminal, err);
      }
    };

    initialFitResizeTimer = window.setTimeout(() => {
      void waitForBundledTerminalFont({
        usesBundledTerminalFont: input.usesBundledTerminalFont,
        terminalFontSize: input.terminalFontSize,
      }).then(() => {
        if (disposed) return;
        window.requestAnimationFrame(() => {
          if (disposed) return;
          fitAndResizeServerTerminal({
            terminalRef: input.terminalRef,
            fitAddonRef: input.fitAddonRef,
            threadId: input.threadId,
            terminalId: input.terminalId,
          });
        });
      });
    }, 30);
    void runOpenTerminal();

    return () => {
      disposed = true;
      terminalHydratedRef.current = false;
      lastAppliedTerminalEventIdRef.current = 0;
      unsubscribeTerminalEvents();
      if (initialFitResizeTimer !== null) {
        window.clearTimeout(initialFitResizeTimer);
      }
      if (openTerminalRetryTimer !== null) {
        window.clearTimeout(openTerminalRetryTimer);
      }
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      themeObserver.disconnect();
      writeBatcher.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
  }, [
    input.autoFocusRef,
    input.containerRef,
    input.cwd,
    input.dropPathModeRef,
    input.executionTargetId,
    input.fitAddonRef,
    input.hasHandledExitRef,
    input.lastAppliedTerminalEventIdRef,
    input.runtimeEnv,
    input.selectionActionOpenRef,
    input.selectionActionRequestIdRef,
    input.selectionActionTimerRef,
    input.selectionGestureActiveRef,
    input.selectionPointerRef,
    input.terminalFontFamily,
    input.terminalFontSize,
    input.terminalHydratedRef,
    input.terminalId,
    input.terminalRef,
    input.threadId,
    input.usesBundledTerminalFont,
    input.worktreePathRef,
  ]);
}
