import { type FitAddon } from "@xterm/addon-fit";
import { type Terminal } from "@xterm/xterm";
import { type ExecutionTargetId, type TerminalEvent, type ThreadId } from "@bigbud/contracts";
import { type MutableRefObject, type RefObject } from "react";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import { BIGBUD_FILES_PANEL_DRAG_MIME, parseFilesPanelDragEntry } from "../files/filesPanel.dnd";

import { readNativeApi } from "../../rpc/nativeApi";
import { selectTerminalEventEntries } from "../../stores/terminal";
import { useTerminalStateStore } from "../../stores/terminal";
import { canTerminalAutoFocus } from "~/lib/terminalFocus";
import {
  getTerminalSelectionRect,
  resolveTerminalSelectionActionPosition,
  selectTerminalEventEntriesAfterSnapshot,
  writeSystemMessage,
  writeTerminalSnapshot,
} from "./ThreadTerminalDrawer.logic";
import { type TerminalWriteBatcher } from "./TerminalWriteBatcher";

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
  readonly writeBatcher: TerminalWriteBatcher;
  readonly threadId: ThreadId;
  readonly terminalId: string;
  readonly executionTargetId?: ExecutionTargetId | undefined;
  readonly cwd: string;
  readonly runtimeEnv?: Record<string, string> | undefined;
  readonly worktreePathRef: MutableRefObject<string | null | undefined>;
  readonly usesBundledTerminalFont: boolean;
  readonly terminalFontSize: number;
  readonly applyTerminalEvent: (event: TerminalEvent) => void;
  readonly lastAppliedTerminalEventIdRef: MutableRefObject<number>;
  readonly terminalHydratedRef: MutableRefObject<boolean>;
  readonly autoFocusRef: MutableRefObject<boolean>;
  readonly containerRef: RefObject<HTMLDivElement | null>;
}

export function clearSelectionAction(refs: TerminalSelectionActionStateRefs) {
  refs.selectionActionRequestIdRef.current += 1;
  if (refs.selectionActionTimerRef.current !== null) {
    window.clearTimeout(refs.selectionActionTimerRef.current);
    refs.selectionActionTimerRef.current = null;
  }
}

export function acceptsTerminalDrop(types: ReadonlyArray<string>): boolean {
  return types.includes(BIGBUD_FILES_PANEL_DRAG_MIME) || types.includes("Files");
}

interface ReadDroppedTerminalPathsInput {
  dataTransfer: Pick<DataTransfer, "files" | "getData" | "types">;
  readNativeFilePath: (file: File) => string;
}

export function readDroppedTerminalPaths(
  input: ReadDroppedTerminalPathsInput,
): ReadonlyArray<string> {
  if (input.dataTransfer.types.includes(BIGBUD_FILES_PANEL_DRAG_MIME)) {
    const payload = parseFilesPanelDragEntry(
      input.dataTransfer.getData(BIGBUD_FILES_PANEL_DRAG_MIME),
    );
    if (payload) {
      return [payload.path];
    }
  }

  const paths = Array.from(input.dataTransfer.files, input.readNativeFilePath).filter(
    (path) => path.length > 0,
  );
  if (paths.length > 0) {
    return paths;
  }

  return [];
}

function looksLikeWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function quotePosixPath(path: string): string {
  if (path.length === 0) {
    return "''";
  }
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function quoteWindowsPath(path: string): string {
  if (path.length === 0) {
    return '""';
  }
  return `"${path.replaceAll('"', '""')}"`;
}

export function formatDroppedTerminalPath(path: string): string {
  return looksLikeWindowsPath(path) ? quoteWindowsPath(path) : quotePosixPath(path);
}

export function pasteDroppedTerminalPaths(input: {
  terminal: Pick<Terminal, "focus" | "paste"> | null;
  paths: ReadonlyArray<string>;
}): boolean {
  if (!input.terminal || input.paths.length === 0) {
    return false;
  }

  input.terminal.focus();
  input.terminal.paste(input.paths.map(formatDroppedTerminalPath).join(" "));
  return true;
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
    input.selectionActionOpenRef.current = false;
  }
}

export async function waitForBundledTerminalFont(input: {
  usesBundledTerminalFont: boolean;
  terminalFontSize: number;
}) {
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
  await Promise.race([document.fonts.load(fontLoadTarget).then(() => undefined), timeout]).catch(
    () => undefined,
  );
}

export function fitTerminalViewport(input: {
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
}) {
  const activeTerminal = input.terminalRef.current;
  const activeFitAddon = input.fitAddonRef.current;
  if (!activeTerminal || !activeFitAddon) return;
  const wasAtBottom = activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
  activeFitAddon.fit();
  if (wasAtBottom) {
    activeTerminal.scrollToBottom();
  }
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
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  threadId: ThreadId;
  terminalId: string;
}) {
  fitTerminalViewport(input);
  resizeServerTerminal(input);
}

export function hasUsableTerminalViewportSize(containerRef: RefObject<HTMLDivElement | null>) {
  const mountElement = containerRef.current;
  if (!mountElement) return false;
  const { width, height } = mountElement.getBoundingClientRect();
  return width >= 32 && height >= 32;
}

export async function openTerminalSession(input: TerminalOpenSessionInput): Promise<boolean> {
  const api = readNativeApi();
  if (!api) {
    return false;
  }
  const activeTerminal = input.terminalRef.current;
  if (!activeTerminal || !input.fitAddonRef.current) return true;
  await waitForBundledTerminalFont({
    usesBundledTerminalFont: input.usesBundledTerminalFont,
    terminalFontSize: input.terminalFontSize,
  });
  if (input.disposed()) return true;
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
  if (input.disposed()) return true;
  if (!hasUsableTerminalViewportSize(input.containerRef)) {
    return false;
  }
  fitAndResizeServerTerminal({
    terminalRef: input.terminalRef,
    fitAddonRef: input.fitAddonRef,
    threadId: input.threadId,
    terminalId: input.terminalId,
  });
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
  if (input.disposed()) return true;
  input.writeBatcher.flush();
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
    input.applyTerminalEvent(entry.event);
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
  return true;
}

export function writeTerminalOpenFailure(terminal: Terminal, error: unknown) {
  writeSystemMessage(terminal, error instanceof Error ? error.message : "Failed to open terminal");
}
