import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { useEffect, useRef, useState } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { readNativeApi } from "../../rpc/nativeApi";
import { terminalThemeFromApp } from "./ThreadTerminalDrawer.logic";
import { createTerminalViewportDelivery } from "./TerminalViewport.delivery";
import { subscribeTerminalOutput } from "./TerminalOutputStream";
import { useTerminalTypography } from "./TerminalViewport.typography";
import { attachTerminalRenderer } from "./TerminalViewport.rendering";
import { TerminalFontController } from "./TerminalFontController";
import { SYSTEM_TERMINAL_FONT_FAMILY } from "./terminalTypography";
import type { TerminalRendererState } from "./TerminalRendererController";
import { attachTerminalKeybindings } from "./TerminalViewport.keybindings";
import { makeTerminalLinkProvider } from "./TerminalViewport.links";
import { createTerminalWebLinkHandler } from "./TerminalViewport.links.web";
import { clearSelectionAction, openTerminalSession } from "./TerminalViewport.session.helpers";
import { attachTerminalSelection } from "./TerminalViewport.selection";
import { makeTerminalRestartAction } from "./TerminalViewport.restart";
import { TerminalHistoryUnavailableError } from "./TerminalHistoryUnavailableError";
import type { UseTerminalViewportSessionInput } from "./TerminalViewport.session.types";

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
  const [inputEnabled, setInputEnabled] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const [startupPending, setStartupPending] = useState(true);
  const [startupFailed, setStartupFailed] = useState(false);
  const [directoryNotice, setDirectoryNotice] = useState<string | null>(null);
  const [rendering, setRendering] = useState<TerminalRendererState>({ mode: "dom", reason: null });
  const rendererRef = useRef<ReturnType<typeof attachTerminalRenderer> | null>(null);
  const fontControllerRef = useRef<TerminalFontController | null>(null);
  const retryDeliveryRef = useRef<() => void>(() => undefined);
  const restartDeliveryRef = useRef<() => void>(() => undefined);
  const typographyRef = useRef(input);
  typographyRef.current = input;

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
    const selectionActionTimerRef = input.selectionActionTimerRef;
    const selectionActionOpenRef = input.selectionActionOpenRef;
    const terminalRef = input.terminalRef;
    const fitAddonRef = input.fitAddonRef;
    const clearSelectionActionState = () =>
      clearSelectionAction({
        selectionActionRequestIdRef: input.selectionActionRequestIdRef,
        selectionActionTimerRef: input.selectionActionTimerRef,
      });

    let disposed = false;
    const fitAddon = new FitAddon();
    setDeliveryError(null);
    setHistoryUnavailable(false);
    setRendering({ mode: "dom", reason: null });
    const themeHost =
      mount.closest<HTMLElement>(".thread-terminal-theme-host") ??
      mount.closest<HTMLElement>(".thread-terminal-drawer") ??
      mount;
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: typographyRef.current.terminalLineHeight,
      fontSize: typographyRef.current.terminalFontSize,
      scrollback: 5_000,
      // The bundled family is applied only after loading, triggering real measurement.
      fontFamily: SYSTEM_TERMINAL_FONT_FAMILY,
      disableStdin: true,
      theme: terminalThemeFromApp(themeHost),
      linkHandler: createTerminalWebLinkHandler(),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    const renderer = attachTerminalRenderer(terminal, mount, setRendering);
    rendererRef.current = renderer;
    renderer.update(typographyRef.current.terminalGpuAcceleration, typographyRef.current.visible);

    input.terminalRef.current = terminal;
    input.fitAddonRef.current = fitAddon;
    const fontController = new TerminalFontController(terminal);
    fontControllerRef.current = fontController;
    void fontController.update(typographyRef.current);

    const api = readNativeApi();
    if (!api) {
      input.terminalRef.current = null;
      input.fitAddonRef.current = null;
      renderer.dispose();
      rendererRef.current = null;
      fontController.dispose();
      fontControllerRef.current = null;
      terminal.dispose();
      return;
    }

    const createDelivery = () =>
      createTerminalViewportDelivery({
        terminalRef,
        hasHandledExitRef: input.hasHandledExitRef,
        dropPathModeRef: input.dropPathModeRef,
        clearSelectionAction: clearSelectionActionState,
        handleSessionExited: () => onSessionExitedRef.current(),
        onInputState: (enabled) => {
          if (!disposed) setInputEnabled(enabled);
        },
        onFailure: (error) => {
          if (!disposed) {
            setDeliveryError(error.message);
            if (error instanceof TerminalHistoryUnavailableError) setHistoryUnavailable(true);
          }
        },
      });
    let delivery = createDelivery();
    const writeNotice = (target: Terminal, message: string) => {
      if (!disposed) delivery.writeBatcher.write(target, `\r\n[terminal] ${message}\r\n`);
    };
    const registerLinks = (context: {
      cwd: string;
      worktreePath?: string | null | undefined;
      executionTargetId?: string | undefined;
    }) =>
      terminal.registerLinkProvider(
        makeTerminalLinkProvider({
          terminalRef: input.terminalRef,
          cwd: context.cwd,
          workspaceRoot: context.worktreePath ?? context.cwd,
          executionTargetId: context.executionTargetId,
          api,
          writeNotice,
        }),
      );
    let terminalLinksDisposable = registerLinks({
      cwd: input.cwd,
      executionTargetId: input.executionTargetId,
      worktreePath: input.worktreePathRef.current,
    });
    const inputDisposable = terminal.onData((data) => {
      if (disposed || !delivery.intake.acceptsInput) return;
      void api.terminal
        .write({ threadId: input.threadId, terminalId: input.terminalId, data })
        .catch((err) => {
          writeNotice(terminal, err instanceof Error ? err.message : "Terminal write failed");
        });
    });
    attachTerminalKeybindings({
      terminal,
      terminalRef: input.terminalRef,
      threadId: input.threadId,
      terminalId: input.terminalId,
      keybindingsRef: input.keybindingsRef,
      api,
      acceptsInput: () => !disposed && delivery.intake.acceptsInput,
      writeNotice,
    });
    const disposeSelection = attachTerminalSelection({
      containerRef: input.containerRef,
      terminalRef: input.terminalRef,
      terminalId: input.terminalId,
      selectionPointerRef: input.selectionPointerRef,
      selectionActionOpenRef: input.selectionActionOpenRef,
      selectionActionRequestIdRef: input.selectionActionRequestIdRef,
      selectionActionTimerRef: input.selectionActionTimerRef,
      selectionGestureActiveRef: input.selectionGestureActiveRef,
      terminal,
      mount,
      disposed: () => disposed,
      clearSelectionAction: clearSelectionActionState,
      onAddTerminalContext,
      onRequestTerminalAnnotation,
      readTerminalLabel,
    });

    const themeObserver = new MutationObserver(() => {
      if (disposed) return;
      const activeTerminal = input.terminalRef.current;
      if (!activeTerminal) return;
      activeTerminal.options.theme = terminalThemeFromApp(themeHost);
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    let unsubscribeTerminalEvents: (() => void) | null = null;
    const subscribe = () => {
      unsubscribeTerminalEvents ??= subscribeTerminalOutput(
        input.threadId,
        input.terminalId,
        (event) => delivery.intake.receive(event),
      );
    };

    let openTerminalRetryTimer: number | null = null;
    let hasRunningSnapshot = false;
    let lastSnapshot: TerminalSessionSnapshot | null = null;
    const onSnapshot = (snapshot: TerminalSessionSnapshot) => {
      lastSnapshot = snapshot;
      input.dropPathModeRef.current = snapshot.dropPathMode;
      terminalLinksDisposable.dispose();
      terminalLinksDisposable = registerLinks(snapshot);
      hasRunningSnapshot = snapshot.status === "running" && snapshot.pid !== null;
      setStartupPending(false);
      setStartupFailed(!hasRunningSnapshot);
      setHistoryUnavailable(Boolean(snapshot.historyTruncated || snapshot.historyUnavailable));
      setDirectoryNotice(
        snapshot.directoryFallback
          ? `${snapshot.directoryFallback.reason}: ${snapshot.directoryFallback.requestedCwd}. Started in ${snapshot.cwd}.`
          : null,
      );
    };
    const runOpenTerminal = async (attachOnly = false) => {
      const owner = delivery;
      try {
        const opened = await openTerminalSession({
          disposed: () => disposed || delivery !== owner,
          terminalRef: input.terminalRef,
          fitAddonRef: input.fitAddonRef,
          intake: owner.intake,
          attachOnly,
          beforeOpen: subscribe,
          threadId: input.threadId,
          terminalId: input.terminalId,
          executionTargetId: input.executionTargetId,
          cwd: input.cwd,
          runtimeEnv: input.runtimeEnv,
          worktreePathRef: input.worktreePathRef,
          dropPathModeRef: input.dropPathModeRef,
          waitForTypography: () => fontController.whenReady(),
          onSnapshot,
          autoFocusRef: input.autoFocusRef,
          containerRef: input.containerRef,
        });
        if (!opened) {
          openTerminalRetryTimer = window.setTimeout(() => {
            openTerminalRetryTimer = null;
            void runOpenTerminal(attachOnly);
          }, 50);
        }
      } catch (err) {
        if (disposed || delivery !== owner) return;
        setStartupPending(false);
        setStartupFailed(!hasRunningSnapshot);
        owner.intake.pause(err instanceof Error ? err : new Error("Failed to open terminal"));
      }
    };
    const replaceDelivery = () => {
      if (openTerminalRetryTimer !== null) window.clearTimeout(openTerminalRetryTimer);
      delivery.dispose();
      unsubscribeTerminalEvents?.();
      unsubscribeTerminalEvents = null;
      setDeliveryError(null);
      setStartupPending(!hasRunningSnapshot);
      setStartupFailed(false);
      delivery = createDelivery();
      input.hasHandledExitRef.current = false;
      return delivery;
    };
    retryDeliveryRef.current = () => {
      if (disposed || !delivery.writeBatcher.isStopped) return;
      replaceDelivery();
      void runOpenTerminal(hasRunningSnapshot);
    };
    restartDeliveryRef.current = makeTerminalRestartAction({
      api,
      terminal,
      readSnapshot: () => lastSnapshot,
      disposed: () => disposed,
      prepare: () => {
        const owner = replaceDelivery();
        subscribe();
        return owner;
      },
      isCurrent: (owner) => delivery === owner,
      onSnapshot,
      onFailure: (error) => {
        setHistoryUnavailable(true);
        setDeliveryError(error.message);
      },
    });

    void runOpenTerminal();

    return () => {
      disposed = true;
      clearSelectionActionState();
      retryDeliveryRef.current = () => undefined;
      restartDeliveryRef.current = () => undefined;
      delivery.dispose();
      selectionActionOpenRef.current = false;
      unsubscribeTerminalEvents?.();
      if (openTerminalRetryTimer !== null) {
        window.clearTimeout(openTerminalRetryTimer);
      }
      inputDisposable.dispose();
      disposeSelection();
      terminalLinksDisposable.dispose();
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      themeObserver.disconnect();
      renderer.dispose();
      fontController.dispose();
      if (fontControllerRef.current === fontController) fontControllerRef.current = null;
      if (rendererRef.current === renderer) rendererRef.current = null;
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
    input.keybindingsRef,
    input.runtimeEnv,
    input.selectionActionOpenRef,
    input.selectionActionRequestIdRef,
    input.selectionActionTimerRef,
    input.selectionGestureActiveRef,
    input.selectionPointerRef,
    input.terminalId,
    input.terminalRef,
    input.threadId,
    input.worktreePathRef,
  ]);
  // Register typography effects after session creation so the initial controller exists.
  useTerminalTypography({ ...input, fontControllerRef, serverReady: inputEnabled });
  useEffect(() => {
    rendererRef.current?.update(input.terminalGpuAcceleration, input.visible);
  }, [input.terminalGpuAcceleration, input.visible]);
  return {
    inputEnabled,
    deliveryError,
    historyUnavailable,
    startupPending,
    startupFailed,
    directoryNotice,
    rendering,
    retryGpu: () => rendererRef.current?.retry(),
    retryDelivery: () => retryDeliveryRef.current(),
    restartDelivery: () => restartDeliveryRef.current(),
  };
}
