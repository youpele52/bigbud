import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { type ThreadId } from "@bigbud/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { readNativeApi } from "../../rpc/nativeApi";
import { makeTerminalLinkProvider } from "./TerminalViewport.links";
import { selectTerminalEventEntries } from "../../stores/terminal";
import { useTerminalStateStore } from "../../stores/terminal";
import { useSettings } from "../../hooks/useSettings";
import {
  getTerminalSelectionRect,
  terminalFontFamilyFromSettings,
  resolveTerminalSelectionActionPosition,
  selectTerminalEventEntriesAfterSnapshot,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
  terminalThemeFromApp,
  writeSystemMessage,
  writeTerminalSnapshot,
} from "./ThreadTerminalDrawer.logic";
import { applyPendingTerminalEvents, makeApplyTerminalEvent } from "./TerminalViewport.events";
import { useTerminalKeybindings } from "./TerminalViewport.keybindings";

export interface TerminalViewportProps {
  threadId: ThreadId;
  terminalId: string;
  terminalLabel: string;
  cwd: string;
  worktreePath?: string | null;
  runtimeEnv?: Record<string, string>;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  drawerHeight: number;
}

export function TerminalViewport({
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  worktreePath,
  runtimeEnv,
  onSessionExited,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  drawerHeight,
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
  });

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let disposed = false;

    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1.2,
      fontSize: terminalFontSize,
      scrollback: 5_000,
      fontFamily: terminalFontFamily,
      theme: terminalThemeFromApp(),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const api = readNativeApi();
    if (!api) return;

    const clearSelectionAction = () => {
      selectionActionRequestIdRef.current += 1;
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
    };

    const readSelectionAction = (): {
      position: { x: number; y: number };
      selection: TerminalContextSelection;
    } | null => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
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
        pointer: selectionPointerRef.current,
      });
      return {
        position,
        selection: {
          terminalId,
          terminalLabel: readTerminalLabel(),
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const showSelectionAction = async () => {
      if (selectionActionOpenRef.current) {
        return;
      }
      const nextAction = readSelectionAction();
      if (!nextAction) {
        clearSelectionAction();
        return;
      }
      const requestId = ++selectionActionRequestIdRef.current;
      selectionActionOpenRef.current = true;
      try {
        const clicked = await api.contextMenu.show(
          [{ id: "add-to-chat", label: "Add to chat" }],
          nextAction.position,
        );
        if (requestId !== selectionActionRequestIdRef.current || clicked !== "add-to-chat") {
          return;
        }
        handleAddTerminalContext(nextAction.selection);
        terminalRef.current?.clearSelection();
        terminalRef.current?.focus();
      } finally {
        selectionActionOpenRef.current = false;
      }
    };

    const terminalLinksDisposable = terminal.registerLinkProvider(
      makeTerminalLinkProvider({ terminalRef, cwd, api }),
    );

    const inputDisposable = terminal.onData((data) => {
      void api.terminal
        .write({ threadId, terminalId, data })
        .catch((err) =>
          writeSystemMessage(
            terminal,
            err instanceof Error ? err.message : "Terminal write failed",
          ),
        );
    });

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminalRef.current?.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void showSelectionAction();
        });
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };
    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      activeTerminal.options.theme = terminalThemeFromApp();
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const applyTerminalEvent = makeApplyTerminalEvent({
      terminalRef,
      hasHandledExitRef,
      clearSelectionAction,
      handleSessionExited,
    });

    const unsubscribeTerminalEvents = useTerminalStateStore.subscribe((state, previousState) => {
      if (!terminalHydratedRef.current) {
        return;
      }

      const previousLastEntryId =
        selectTerminalEventEntries(
          previousState.terminalEventEntriesByKey,
          threadId,
          terminalId,
        ).at(-1)?.id ?? 0;
      const nextEntries = selectTerminalEventEntries(
        state.terminalEventEntriesByKey,
        threadId,
        terminalId,
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
      if (!usesBundledTerminalFont || typeof document.fonts === "undefined") {
        return;
      }

      const fontLoadTarget = `${terminalFontSize}px "MesloLGL Nerd Font Mono"`;
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
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon) return;
      const wasAtBottom =
        activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
      activeFitAddon.fit();
      if (wasAtBottom) {
        activeTerminal.scrollToBottom();
      }
    };

    const resizeServerTerminal = () => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      void api.terminal
        .resize({
          threadId,
          terminalId,
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
        })
        .catch(() => undefined);
    };

    const fitAndResizeServerTerminal = () => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      fitTerminal();
      resizeServerTerminal();
    };

    const runOpenTerminal = async () => {
      try {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal || !fitAddonRef.current) return;
        await waitForBundledTerminalFont();
        if (disposed) return;
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve());
        });
        if (disposed) return;
        fitAndResizeServerTerminal();
        const snapshot = await api.terminal.open({
          threadId,
          terminalId,
          cwd,
          ...(worktreePathRef.current !== undefined
            ? { worktreePath: worktreePathRef.current }
            : {}),
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
          ...(runtimeEnv ? { env: runtimeEnv } : {}),
        });
        if (disposed) return;
        writeTerminalSnapshot(activeTerminal, snapshot);
        const bufferedEntries = selectTerminalEventEntries(
          useTerminalStateStore.getState().terminalEventEntriesByKey,
          threadId,
          terminalId,
        );
        const replayEntries = selectTerminalEventEntriesAfterSnapshot(
          bufferedEntries,
          snapshot.updatedAt,
        );
        for (const entry of replayEntries) {
          applyTerminalEvent(entry.event);
        }
        lastAppliedTerminalEventIdRef.current = bufferedEntries.at(-1)?.id ?? 0;
        terminalHydratedRef.current = true;
        if (autoFocusRef.current) {
          window.requestAnimationFrame(() => {
            activeTerminal.focus();
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
    // autoFocus is intentionally omitted — it is only read at mount time via autoFocusRef
    // and must not trigger terminal teardown/recreation.
    // worktreePath is intentionally omitted — same reason, accessed via worktreePathRef.
  }, [
    cwd,
    runtimeEnv,
    terminalFontFamily,
    terminalFontSize,
    terminalId,
    threadId,
    usesBundledTerminalFont,
  ]);

  useEffect(() => {
    if (!autoFocus) return;
    void focusRequestId;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => {
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
