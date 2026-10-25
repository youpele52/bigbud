import { type FitAddon } from "@xterm/addon-fit";
import { type Terminal } from "@xterm/xterm";
import {
  type ExecutionTargetId,
  type TerminalDropPathMode,
  type ThreadId,
} from "@bigbud/contracts";
import { type MutableRefObject, type RefObject } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";

import { readNativeApi } from "../../rpc/nativeApi";
import { useTerminalStateStore } from "../../stores/terminal";
import { canTerminalAutoFocus } from "~/lib/terminalFocus";
import {
  getTerminalSelectionRect,
  resolveTerminalSelectionActionPosition,
  writeSystemMessage,
} from "./ThreadTerminalDrawer.logic";
import type { TerminalViewportIntake } from "./TerminalViewport.intake";
import { ensureThreadMaterialized } from "../../lib/threadMaterialization";
import { recordTerminalLaunch } from "../../lib/terminalLaunchBinding";
import { preserveTerminalScroll } from "./terminalScrollState";

interface TerminalSelectionActionStateRefs {
  readonly selectionActionRequestIdRef: MutableRefObject<number>;
  readonly selectionActionTimerRef: MutableRefObject<number | null>;
}

interface TerminalViewportSelectionRefs extends TerminalSelectionActionStateRefs {
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly terminalRef: MutableRefObject<Terminal | null>;
  readonly selectionPointerRef: MutableRefObject<{ x: number; y: number } | null>;
  readonly selectionActionOpenRef: MutableRefObject<boolean>;
  readonly terminalId: string;
}

interface ReadTerminalSelectionActionInput extends TerminalViewportSelectionRefs {
  readonly readTerminalLabel: () => string;
}

interface ShowTerminalSelectionActionInput extends ReadTerminalSelectionActionInput {
  readonly clearSelectionAction: () => void;
  readonly onAddTerminalContext: (selection: TerminalContextSelection) => void;
  readonly onRequestTerminalAnnotation: (input: {
    selection: TerminalContextSelection;
    position: { x: number; y: number };
    selectionRect: { left: number; top: number; right: number; bottom: number } | null;
  }) => void;
}

interface TerminalOpenSessionInput {
  readonly disposed: () => boolean;
  readonly terminalRef: MutableRefObject<Terminal | null>;
  readonly fitAddonRef: MutableRefObject<FitAddon | null>;
  readonly intake: TerminalViewportIntake;
  readonly threadId: ThreadId;
  readonly terminalId: string;
  readonly executionTargetId?: ExecutionTargetId | undefined;
  readonly cwd: string;
  readonly runtimeEnv?: Record<string, string> | undefined;
  readonly worktreePathRef: MutableRefObject<string | null | undefined>;
  readonly dropPathModeRef: MutableRefObject<TerminalDropPathMode>;
  readonly waitForTypography: () => Promise<void>;
  readonly autoFocusRef: MutableRefObject<boolean>;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly attachOnly?: boolean;
  /** Subscribes the view; open waits for the server-side registration so no event is missed. */
  readonly beforeOpen?: () => void | Promise<void>;
  readonly onSnapshot?: (
    snapshot: import("@bigbud/contracts/workspace/terminal.ts").TerminalSessionSnapshot,
  ) => void;
}

export function clearSelectionAction(refs: TerminalSelectionActionStateRefs) {
  refs.selectionActionRequestIdRef.current += 1;
  if (refs.selectionActionTimerRef.current !== null) {
    window.clearTimeout(refs.selectionActionTimerRef.current);
    refs.selectionActionTimerRef.current = null;
  }
}

export function readTerminalSelectionAction(input: ReadTerminalSelectionActionInput): {
  position: { x: number; y: number };
  selection: TerminalContextSelection;
  selectionRect: { left: number; top: number; right: number; bottom: number } | null;
} | null {
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
      selectionRect === null ? null : { right: selectionRect.right, bottom: selectionRect.bottom },
    pointer: input.selectionPointerRef.current,
  });
  return {
    position,
    selectionRect:
      selectionRect === null
        ? null
        : {
            left: selectionRect.left,
            top: selectionRect.top,
            right: selectionRect.right,
            bottom: selectionRect.bottom,
          },
    selection: {
      terminalId: input.terminalId,
      terminalLabel: input.readTerminalLabel(),
      lineStart,
      lineEnd,
      text: normalizedText,
    },
  };
}

export async function showTerminalSelectionAction(input: ShowTerminalSelectionActionInput) {
  if (input.selectionActionOpenRef.current) {
    return;
  }
  const api = readNativeApi();
  if (!api) {
    input.clearSelectionAction();
    return;
  }
  const nextAction = readTerminalSelectionAction(input);
  if (!nextAction) {
    input.clearSelectionAction();
    return;
  }
  const requestId = ++input.selectionActionRequestIdRef.current;
  input.selectionActionOpenRef.current = true;
  try {
    const clicked = await api.contextMenu.show(
      [
        { id: "add-to-chat", label: "Add to chat" },
        { id: "annotate-selection", label: "Annotate selection" },
      ],
      nextAction.position,
    );
    if (requestId !== input.selectionActionRequestIdRef.current) {
      return;
    }
    if (clicked === "add-to-chat") {
      input.onAddTerminalContext(nextAction.selection);
      input.terminalRef.current?.clearSelection();
      input.terminalRef.current?.focus();
      return;
    }
    if (clicked === "annotate-selection") {
      input.onRequestTerminalAnnotation({
        selection: nextAction.selection,
        position: nextAction.position,
        selectionRect: nextAction.selectionRect,
      });
      input.terminalRef.current?.clearSelection();
    }
  } finally {
    if (requestId === input.selectionActionRequestIdRef.current)
      input.selectionActionOpenRef.current = false;
  }
}

export function fitTerminalViewport(input: {
  containerRef: RefObject<HTMLDivElement | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
}) {
  const activeTerminal = input.terminalRef.current;
  const activeFitAddon = input.fitAddonRef.current;
  if (!activeTerminal || !activeFitAddon || !hasUsableTerminalViewportSize(input.containerRef))
    return false;
  preserveTerminalScroll(activeTerminal, () => activeFitAddon.fit());
  return true;
}

export function resizeServerTerminal(input: {
  terminalRef: MutableRefObject<Terminal | null>;
  threadId: ThreadId;
  terminalId: string;
}) {
  const activeTerminal = input.terminalRef.current;
  if (!activeTerminal) return;
  const api = readNativeApi();
  if (!api) return;
  void api.terminal
    .resize({
      threadId: input.threadId,
      terminalId: input.terminalId,
      cols: activeTerminal.cols,
      rows: activeTerminal.rows,
    })
    .catch(() => undefined);
}

export function fitAndResizeServerTerminal(input: {
  containerRef: RefObject<HTMLDivElement | null>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  threadId: ThreadId;
  terminalId: string;
}) {
  if (fitTerminalViewport(input)) resizeServerTerminal(input);
}

export function hasUsableTerminalViewportSize(containerRef: RefObject<HTMLDivElement | null>) {
  const mountElement = containerRef.current;
  if (!mountElement) return false;
  const { width, height } = mountElement.getBoundingClientRect();
  const visibility = getComputedStyle(mountElement).visibility;
  return width >= 32 && height >= 32 && visibility !== "hidden" && visibility !== "collapse";
}

export async function openTerminalSession(input: TerminalOpenSessionInput): Promise<boolean> {
  const api = readNativeApi();
  if (!api) {
    return false;
  }
  const activeTerminal = input.terminalRef.current;
  if (!activeTerminal || !input.fitAddonRef.current) return true;
  await input.waitForTypography();
  if (input.disposed()) return true;
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
  if (input.disposed()) return true;
  if (!hasUsableTerminalViewportSize(input.containerRef)) {
    return false;
  }
  fitTerminalViewport(input);
  // Subscribe immediately before the snapshot request, not during font/layout waits.
  await input.beforeOpen?.();
  if (input.disposed()) return true;
  if (!input.attachOnly) await ensureThreadMaterialized(input.threadId);
  if (input.disposed()) return true;
  if (input.attachOnly && !api.terminal.snapshot) {
    throw new Error(
      "View-only recovery is unavailable. Upgrade the server; the running process was not restarted.",
    );
  }
  const snapshot = input.attachOnly
    ? await api.terminal.snapshot!({ threadId: input.threadId, terminalId: input.terminalId })
    : await api.terminal.open({
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
  if (input.disposed()) return true;
  input.onSnapshot?.(snapshot);
  recordTerminalLaunch(snapshot);
  if (snapshot.status === "error" || snapshot.pid === null) {
    throw new Error(
      "The terminal did not start. Check the target and shell configuration, then retry startup.",
    );
  }
  useTerminalStateStore.getState().hydrateTerminalAgentFromSnapshot(snapshot);
  if (
    input.intake.snapshotUpdatedAt === null ||
    snapshot.updatedAt >= input.intake.snapshotUpdatedAt
  ) {
    input.dropPathModeRef.current = snapshot.dropPathMode;
  }
  await input.intake.hydrate(snapshot);
  if (input.disposed()) return true;
  // Resize requests made while open was pending may have reached a not-yet-running
  // PTY. Reconcile current geometry after replay, rather than leaving open's old size.
  fitAndResizeServerTerminal(input);
  if (input.autoFocusRef.current && canTerminalAutoFocus()) {
    window.requestAnimationFrame(() => {
      if (!input.disposed() && canTerminalAutoFocus()) {
        activeTerminal.focus();
      }
    });
  }
  return true;
}

export function writeTerminalOpenFailure(terminal: Terminal, error: unknown) {
  writeSystemMessage(terminal, error instanceof Error ? error.message : "Failed to open terminal");
}
