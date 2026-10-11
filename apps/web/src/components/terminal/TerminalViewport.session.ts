import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  type ExecutionTargetId,
  type ResolvedKeybindingsConfig,
  type TerminalDropPathMode,
  type ThreadId,
} from "@bigbud/contracts";
import { useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { readNativeApi } from "../../rpc/nativeApi";
import {
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
  terminalThemeFromApp,
} from "./ThreadTerminalDrawer.logic";
import { createTerminalViewportDelivery } from "./TerminalViewport.delivery";
import { subscribeTerminalOutput } from "./TerminalOutputStream";
import { useTerminalTypography } from "./TerminalViewport.typography";
import { attachTerminalRenderer } from "./TerminalViewport.rendering";
import type { TerminalRendererState } from "./TerminalRendererController";
import type { TerminalGpuAcceleration } from "@bigbud/contracts/core/settings.ts";
import { attachTerminalKeybindings } from "./TerminalViewport.keybindings";
import { makeTerminalLinkProvider } from "./TerminalViewport.links";
import { createTerminalWebLinkHandler } from "./TerminalViewport.links.web";
import {
  clearSelectionAction,
  fitAndResizeServerTerminal,
  openTerminalSession,
  showTerminalSelectionAction,
  waitForBundledTerminalFont,
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
  keybindingsRef: MutableRefObject<ResolvedKeybindingsConfig>;
  autoFocusRef: MutableRefObject<boolean>;
  worktreePathRef: MutableRefObject<string | null | undefined>;
  dropPathModeRef: MutableRefObject<TerminalDropPathMode>;
  threadId: ThreadId;
  visible: boolean;
  terminalId: string;
  readTerminalLabel: () => string;
  executionTargetId?: ExecutionTargetId | undefined;
  cwd: string;
  runtimeEnv?: Record<string, string> | undefined;
  terminalFontFamily: string;
  terminalFontSize: number;
  usesBundledTerminalFont: boolean;
  terminalGpuAcceleration: TerminalGpuAcceleration;
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
  const [inputEnabled, setInputEnabled] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [rendering, setRendering] = useState<TerminalRendererState>({ mode: "dom", reason: null });
  const rendererRef = useRef<ReturnType<typeof attachTerminalRenderer> | null>(null);
  const retryDeliveryRef = useRef<() => void>(() => undefined);
  const typographyRef = useRef(input);
  typographyRef.current = input;
  useTerminalTypography({ ...input, serverReady: inputEnabled });

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
    setRendering({ mode: "dom", reason: null });
    const themeHost =
      mount.closest<HTMLElement>(".thread-terminal-theme-host") ??
      mount.closest<HTMLElement>(".thread-terminal-drawer") ??
      mount;
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1.2,
      fontSize: typographyRef.current.terminalFontSize,
      scrollback: 5_000,
      fontFamily: typographyRef.current.terminalFontFamily,
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

    const api = readNativeApi();
    if (!api) {
      input.terminalRef.current = null;
      input.fitAddonRef.current = null;
      renderer.dispose();
      rendererRef.current = null;
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
          if (!disposed) setDeliveryError(error.message);
        },
      });
    let delivery = createDelivery();
    const writeNotice = (target: Terminal, message: string) => {
      if (!disposed) delivery.writeBatcher.write(target, `\r\n[terminal] ${message}\r\n`);
    };
    const terminalLinksDisposable = terminal.registerLinkProvider(
      makeTerminalLinkProvider({
        terminalRef: input.terminalRef,
        cwd: input.cwd,
        workspaceRoot: input.worktreePathRef.current ?? input.cwd,
        executionTargetId: input.executionTargetId,
        api,
        writeNotice,
      }),
    );
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
        if (disposed || terminalRef.current !== terminal) return;
        input.selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          if (disposed || terminalRef.current !== terminal) return;
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

    let initialFitResizeTimer: number | null = null;
    let openTerminalRetryTimer: number | null = null;
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
          usesBundledTerminalFont: typographyRef.current.usesBundledTerminalFont,
          terminalFontSize: typographyRef.current.terminalFontSize,
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
        owner.intake.pause(err instanceof Error ? err : new Error("Failed to open terminal"));
      }
    };
    retryDeliveryRef.current = () => {
      if (disposed || !delivery.writeBatcher.isStopped) return;
      if (openTerminalRetryTimer !== null) window.clearTimeout(openTerminalRetryTimer);
      delivery.dispose();
      unsubscribeTerminalEvents?.();
      unsubscribeTerminalEvents = null;
      setDeliveryError(null);
      delivery = createDelivery();
      void runOpenTerminal(true);
    };

    initialFitResizeTimer = window.setTimeout(() => {
      void waitForBundledTerminalFont({
        usesBundledTerminalFont: typographyRef.current.usesBundledTerminalFont,
        terminalFontSize: typographyRef.current.terminalFontSize,
      }).then(() => {
        if (disposed || !typographyRef.current.visible) return;
        window.requestAnimationFrame(() => {
          if (disposed || !typographyRef.current.visible || !delivery.intake.acceptsInput) return;
          fitAndResizeServerTerminal({
            containerRef: input.containerRef,
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
      clearSelectionActionState();
      retryDeliveryRef.current = () => undefined;
      delivery.dispose();
      selectionActionOpenRef.current = false;
      unsubscribeTerminalEvents?.();
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
      renderer.dispose();
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
  useEffect(() => {
    rendererRef.current?.update(input.terminalGpuAcceleration, input.visible);
  }, [input.terminalGpuAcceleration, input.visible]);
  return {
    inputEnabled,
    deliveryError,
    rendering,
    retryGpu: () => rendererRef.current?.retry(),
    retryDelivery: () => retryDeliveryRef.current(),
  };
}
