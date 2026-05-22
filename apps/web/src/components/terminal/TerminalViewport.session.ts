import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { type ExecutionTargetId, type ThreadId } from "@bigbud/contracts";
import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { readNativeApi } from "../../rpc/nativeApi";
import { selectTerminalEventEntries } from "../../stores/terminal";
import { useTerminalStateStore } from "../../stores/terminal";
import {
  getTerminalSelectionRect,
  resolveTerminalSelectionActionPosition,
  selectTerminalEventEntriesAfterSnapshot,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
  terminalThemeFromApp,
  writeSystemMessage,
  writeTerminalSnapshot,
} from "./ThreadTerminalDrawer.logic";
import { applyPendingTerminalEvents, makeApplyTerminalEvent } from "./TerminalViewport.events";
import { makeTerminalLinkProvider } from "./TerminalViewport.links";
import { canTerminalAutoFocus } from "~/lib/terminalFocus";

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
}

export function useTerminalViewportSession(input: UseTerminalViewportSessionInput) {
  // Keep callbacks in refs so the session effect does not re-run (and
  // remount the terminal) when upstream function identities change.
  const readTerminalLabelRef = useRef(input.readTerminalLabel);
  readTerminalLabelRef.current = input.readTerminalLabel;
  const onAddTerminalContextRef = useRef(input.onAddTerminalContext);
  onAddTerminalContextRef.current = input.onAddTerminalContext;
  const onSessionExitedRef = useRef(input.onSessionExited);
  onSessionExitedRef.current = input.onSessionExited;

  useEffect(() => {
    const mount = input.containerRef.current;
    if (!mount) return;

    const readTerminalLabel = () => readTerminalLabelRef.current();
    const onAddTerminalContext = (selection: TerminalContextSelection) =>
      onAddTerminalContextRef.current(selection);
    const terminalHydratedRef = input.terminalHydratedRef;
    const lastAppliedTerminalEventIdRef = input.lastAppliedTerminalEventIdRef;
    const selectionActionTimerRef = input.selectionActionTimerRef;
    const terminalRef = input.terminalRef;
    const fitAddonRef = input.fitAddonRef;

    let disposed = false;
    const fitAddon = new FitAddon();
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
    if (!api) return;

    const clearSelectionAction = () => {
      input.selectionActionRequestIdRef.current += 1;
      if (input.selectionActionTimerRef.current !== null) {
        window.clearTimeout(input.selectionActionTimerRef.current);
        input.selectionActionTimerRef.current = null;
      }
    };

    const readSelectionAction = (): {
      position: { x: number; y: number };
      selection: TerminalContextSelection;
    } | null => {
      const activeTerminal = input.terminalRef.current;
      const mountElement = input.containerRef.current;
      if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
        return null;
      }
      const selectionText = activeTerminal.getSelection();
      const selectionPosition = activeTerminal.getSelectionPosition();
      const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!selectionPosition || normalizedText.length === 0) {
        return null;
      }
      const lineStart = selectionPosition.start.y + 1;
      const lineCount = normalizedText.split("\n").length;
      const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
      const bounds = mountElement.getBoundingClientRect();
      const selectionRect = getTerminalSelectionRect(mountElement);
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect:
          selectionRect === null
            ? null
            : { right: selectionRect.right, bottom: selectionRect.bottom },
        pointer: input.selectionPointerRef.current,
      });
      return {
        position,
        selection: {
          terminalId: input.terminalId,
          terminalLabel: readTerminalLabel(),
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const showSelectionAction = async () => {
      if (input.selectionActionOpenRef.current) {
        return;
      }
      const nextAction = readSelectionAction();
      if (!nextAction) {
        clearSelectionAction();
        return;
      }
      const requestId = ++input.selectionActionRequestIdRef.current;
      input.selectionActionOpenRef.current = true;
      try {
        const clicked = await api.contextMenu.show(
          [{ id: "add-to-chat", label: "Add to chat" }],
          nextAction.position,
        );
        if (requestId !== input.selectionActionRequestIdRef.current || clicked !== "add-to-chat") {
          return;
        }
        onAddTerminalContext(nextAction.selection);
        terminalRef.current?.clearSelection();
        terminalRef.current?.focus();
      } finally {
        input.selectionActionOpenRef.current = false;
      }
    };

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
      clearSelectionAction();
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
          void showSelectionAction();
        });
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
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
      clearSelectionAction,
      handleSessionExited: () => onSessionExitedRef.current(),
    });
    const unsubscribeTerminalEvents = useTerminalStateStore.subscribe((state, previousState) => {
      if (!terminalHydratedRef.current) {
        return;
      }
      const previousLastEntryId =
        selectTerminalEventEntries(
          previousState.terminalEventEntriesByKey,
          input.threadId,
          input.terminalId,
        ).at(-1)?.id ?? 0;
      const nextEntries = selectTerminalEventEntries(
        state.terminalEventEntriesByKey,
        input.threadId,
        input.terminalId,
      );
      const nextLastEntryId = nextEntries.at(-1)?.id ?? 0;
      if (nextLastEntryId === previousLastEntryId) {
        return;
      }
      applyPendingTerminalEvents({
        terminalEventEntries: nextEntries,
        lastAppliedTerminalEventIdRef,
        applyTerminalEvent,
      });
    });

    let initialFitResizeTimer: number | null = null;
    const waitForBundledTerminalFont = async () => {
      if (!input.usesBundledTerminalFont || typeof document.fonts === "undefined") {
        return;
      }
      const fontLoadTarget = `${input.terminalFontSize}px "MesloLGL Nerd Font Mono"`;
      if (document.fonts.check(fontLoadTarget)) {
        return;
      }
      const timeout = new Promise<void>((resolve) => {
        window.setTimeout(resolve, 1_000);
      });
      await Promise.race([
        document.fonts.load(fontLoadTarget).then(() => undefined),
        timeout,
      ]).catch(() => undefined);
    };

    const fitTerminal = () => {
      const activeTerminal = input.terminalRef.current;
      const activeFitAddon = input.fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon) return;
      const wasAtBottom =
        activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
      activeFitAddon.fit();
      if (wasAtBottom) {
        activeTerminal.scrollToBottom();
      }
    };
    const resizeServerTerminal = () => {
      const activeTerminal = input.terminalRef.current;
      if (!activeTerminal) return;
      void api.terminal
        .resize({
          threadId: input.threadId,
          terminalId: input.terminalId,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
        })
        .catch(() => undefined);
    };
    const fitAndResizeServerTerminal = () => {
      const activeTerminal = input.terminalRef.current;
      if (!activeTerminal) return;
      fitTerminal();
      resizeServerTerminal();
    };

    const runOpenTerminal = async () => {
      try {
        const activeTerminal = input.terminalRef.current;
        if (!activeTerminal || !input.fitAddonRef.current) return;
        await waitForBundledTerminalFont();
        if (disposed) return;
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
        if (disposed) return;
        fitAndResizeServerTerminal();
        const snapshot = await api.terminal.open({
          threadId: input.threadId,
          terminalId: input.terminalId,
          ...(input.executionTargetId ? { executionTargetId: input.executionTargetId } : {}),
          cwd: input.cwd,
          ...(input.worktreePathRef.current !== undefined
            ? { worktreePath: input.worktreePathRef.current }
            : {}),
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          ...(input.runtimeEnv ? { env: input.runtimeEnv } : {}),
        });
        if (disposed) return;
        writeTerminalSnapshot(activeTerminal, snapshot);
        const bufferedEntries = selectTerminalEventEntries(
          useTerminalStateStore.getState().terminalEventEntriesByKey,
          input.threadId,
          input.terminalId,
        );
        const replayEntries = selectTerminalEventEntriesAfterSnapshot(
          bufferedEntries,
          snapshot.updatedAt,
        );
        for (const entry of replayEntries) {
          applyTerminalEvent(entry.event);
        }
        input.lastAppliedTerminalEventIdRef.current = bufferedEntries.at(-1)?.id ?? 0;
        input.terminalHydratedRef.current = true;
        if (input.autoFocusRef.current && canTerminalAutoFocus()) {
          window.requestAnimationFrame(() => {
            if (canTerminalAutoFocus()) {
              activeTerminal.focus();
            }
          });
        }
      } catch (err) {
        if (disposed) return;
        writeSystemMessage(
          terminal,
          err instanceof Error ? err.message : "Failed to open terminal",
        );
      }
    };

    initialFitResizeTimer = window.setTimeout(() => {
      void waitForBundledTerminalFont().then(() => {
        if (disposed) return;
        window.requestAnimationFrame(() => {
          if (disposed) return;
          fitAndResizeServerTerminal();
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
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      themeObserver.disconnect();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
  }, [
    input.autoFocusRef,
    input.containerRef,
    input.cwd,
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
