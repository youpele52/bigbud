import type { Terminal } from "@xterm/xterm";
import type { TerminalSessionSnapshot } from "@bigbud/contracts/workspace/terminal.ts";
import { useEffect, useRef, useState } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { readNativeApi } from "../../rpc/nativeApi";
import { useTerminalTheme } from "./TerminalViewport.theme";
import { createTerminalViewportDelivery } from "./TerminalViewport.delivery";
import { createTerminalViewportOutput } from "./TerminalViewport.output";
import { useTerminalTypography } from "./TerminalViewport.typography";
import type { TerminalFontController } from "./TerminalFontController";
import type { TerminalRendererState } from "./TerminalRendererController";
import { attachTerminalViewportInput } from "./TerminalViewport.input";
import { createTerminalView, type TerminalView } from "./TerminalViewport.view";
import { useTerminalViewFind, useTerminalViewSettings } from "./TerminalViewport.viewState";
import { makeTerminalLinkProvider } from "./TerminalViewport.links";
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
  const viewRef = useRef<TerminalView | null>(null);
  // A certified-dead write pipeline remounts the emulator; the PTY keeps running.
  const [viewEpoch, setViewEpoch] = useState(0);
  const find = useTerminalViewFind(viewRef, input);
  const { open: openFind, close: closeFind } = find;
  const fontControllerRef = useRef<TerminalFontController | null>(null);
  const retryDeliveryRef = useRef<() => void>(() => undefined);
  const restartDeliveryRef = useRef<() => void>(() => undefined);
  const resyncDeliveryRef = useRef<() => void>(() => undefined);
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
    setDeliveryError(null);
    setHistoryUnavailable(false);
    setRendering({ mode: "dom", reason: null });
    const view = createTerminalView({
      mount,
      settings: typographyRef.current,
      threadId: input.threadId,
      terminalId: input.terminalId,
      executionTargetId: input.executionTargetId,
      onRendering: setRendering,
    });
    const { terminal, fitAddon, instrumentation, fontController } = view;
    viewRef.current = view;
    input.terminalRef.current = terminal;
    input.fitAddonRef.current = fitAddon;
    fontControllerRef.current = fontController;
    const releaseView = () => {
      if (viewRef.current === view) viewRef.current = null;
      if (fontControllerRef.current === fontController) fontControllerRef.current = null;
      if (terminalRef.current === terminal) terminalRef.current = null;
      if (fitAddonRef.current === fitAddon) fitAddonRef.current = null;
      view.dispose();
    };

    const api = readNativeApi();
    if (!api) {
      releaseView();
      return;
    }

    const createDelivery = () => {
      const next = createTerminalViewportDelivery({
        terminalRef,
        hasHandledExitRef: input.hasHandledExitRef,
        dropPathModeRef: input.dropPathModeRef,
        clearSelectionAction: clearSelectionActionState,
        handleSessionExited: () => onSessionExitedRef.current(),
        onInputState: (enabled) => {
          if (!disposed) setInputEnabled(enabled);
        },
        onFailure: (error) => {
          // A stopped lane never acknowledges; release the stream so the PTY is not held.
          output.unsubscribe();
          if (!disposed) {
            setDeliveryError(error.message);
            if (error instanceof TerminalHistoryUnavailableError) setHistoryUnavailable(true);
          }
        },
        observeOutput: instrumentation.observeOutput,
        batcherOptions: {
          ...view.pipeline.batcherOptions,
          isLatencySensitive: instrumentation.isLatencySensitive,
          onParsed: () => output.parsed(),
          onStalled: () => {
            if (!disposed) setViewEpoch((epoch) => epoch + 1);
          },
        },
      });
      instrumentation.bindWriteBatcher(next.writeBatcher);
      return next;
    };
    const output = createTerminalViewportOutput({
      threadId: input.threadId,
      terminalId: input.terminalId,
      receive: (event) => delivery.intake.receive(event),
      outstanding: () => delivery.writeBatcher.outstandingCredit,
      onResync: () => resyncDeliveryRef.current(),
    });
    instrumentation.bindStream(output.diagnostics);
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
    const viewInput = attachTerminalViewportInput({
      terminal,
      terminalRef: input.terminalRef,
      threadId: input.threadId,
      terminalId: input.terminalId,
      keybindingsRef: input.keybindingsRef,
      api,
      acceptsInput: () => !disposed && delivery.intake.acceptsInput,
      markInput: instrumentation.markInput,
      writeNotice,
      tuiWheelMultiplier: view.addons.tuiWheelMultiplier,
      onFind: () => openFind(),
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

    const subscribe = () => output.subscribe();

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
      output.unsubscribe();
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
    // Reconnect or server overflow: replay the snapshot instead of rendering with a gap.
    resyncDeliveryRef.current = () => {
      if (disposed || delivery.writeBatcher.isStopped) return;
      replaceDelivery();
      void runOpenTerminal(hasRunningSnapshot);
    };
    restartDeliveryRef.current = makeTerminalRestartAction({
      api,
      terminal,
      readSnapshot: () => lastSnapshot,
      disposed: () => disposed,
      prepare: async () => {
        const owner = replaceDelivery();
        await subscribe();
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
      resyncDeliveryRef.current = () => undefined;
      restartDeliveryRef.current = () => undefined;
      delivery.dispose();
      selectionActionOpenRef.current = false;
      output.unsubscribe();
      if (openTerminalRetryTimer !== null) {
        window.clearTimeout(openTerminalRetryTimer);
      }
      viewInput.dispose();
      disposeSelection();
      terminalLinksDisposable.dispose();
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      closeFind();
      releaseView();
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
    openFind,
    closeFind,
    viewEpoch,
  ]);
  // Register typography effects after session creation so the initial controller exists.
  useTerminalTypography({ ...input, fontControllerRef, serverReady: inputEnabled });
  useTerminalTheme(input);
  useTerminalViewSettings(viewRef, input);
  return {
    inputEnabled,
    deliveryError,
    historyUnavailable,
    startupPending,
    startupFailed,
    directoryNotice,
    rendering,
    find: find.state,
    retryGpu: () => viewRef.current?.renderer.retry(),
    retryDelivery: () => retryDeliveryRef.current(),
    restartDelivery: () => restartDeliveryRef.current(),
  };
}
