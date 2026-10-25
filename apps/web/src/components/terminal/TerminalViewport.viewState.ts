import type { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useMemo, useState, type MutableRefObject } from "react";
import { TERMINAL_FIND_REQUEST_TTL_MS } from "../../stores/ui/search.store";
import { useSearchStore } from "../../stores/ui";
import type { TerminalView, TerminalViewSettings } from "./TerminalViewport.view";

export interface TerminalFindSeed {
  readonly query: string;
  readonly lineText: string;
}

export interface TerminalFindState {
  readonly open: boolean;
  /** Increments on every find shortcut so an open bar refocuses its input. */
  readonly requestId: number;
  /** Set when opened from a global search hit: prefill this query and reveal this line. */
  readonly seed: TerminalFindSeed | null;
  readonly search: () => SearchAddon | null;
  readonly terminal: () => Terminal | null;
  readonly close: () => void;
}

/**
 * Find-bar visibility for one view; the search addon itself lives on the view. Global search hits
 * for this terminal (`requestTerminalFind`) open it with a seed.
 */
export function useTerminalViewFind(
  viewRef: MutableRefObject<TerminalView | null>,
  target: { readonly threadId: string; readonly terminalId: string },
) {
  const [request, setRequest] = useState<{
    open: boolean;
    requestId: number;
    seed: TerminalFindSeed | null;
  }>({ open: false, requestId: 0, seed: null });
  const open = useCallback((seed: TerminalFindSeed | null = null) => {
    setRequest((current) => ({ open: true, requestId: current.requestId + 1, seed }));
  }, []);
  const pending = useSearchStore((store) => {
    const next = store.terminalFindRequest;
    return next?.threadId === target.threadId && next.terminalId === target.terminalId
      ? next
      : null;
  });
  useEffect(() => {
    if (!pending) return;
    if (Date.now() - pending.createdAt <= TERMINAL_FIND_REQUEST_TTL_MS)
      open({ query: pending.query, lineText: pending.lineText });
    useSearchStore.getState().clearTerminalFindRequest(pending.requestId);
  }, [open, pending]);
  const close = useCallback(() => {
    const search = viewRef.current?.addons.search;
    try {
      search?.clearDecorations();
    } catch {
      /* The view may already be disposed. */
    }
    setRequest((current) => (current.open ? { ...current, open: false } : current));
  }, [viewRef]);
  const state = useMemo<TerminalFindState>(
    () => ({
      open: request.open,
      requestId: request.requestId,
      seed: request.seed,
      search: () => viewRef.current?.addons.search ?? null,
      terminal: () => viewRef.current?.terminal ?? null,
      close: () => {
        close();
        viewRef.current?.terminal.focus();
      },
    }),
    [close, request.open, request.requestId, request.seed, viewRef],
  );
  return { open, close, state };
}

/** Applies renderer and interaction settings to the live view without remounting it. */
export function useTerminalViewSettings(
  viewRef: MutableRefObject<TerminalView | null>,
  settings: TerminalViewSettings,
): void {
  const {
    terminalGpuAcceleration,
    visible,
    terminalFontFamily,
    terminalScrollSensitivity,
    terminalFastScrollSensitivity,
    terminalTuiScrollSensitivity,
    terminalLigatures,
    terminalInlineImages,
  } = settings;
  useEffect(() => {
    viewRef.current?.renderer.update(terminalGpuAcceleration, visible);
  }, [viewRef, terminalGpuAcceleration, visible]);
  useEffect(() => {
    viewRef.current?.addons.update(
      {
        terminalScrollSensitivity,
        terminalFastScrollSensitivity,
        terminalTuiScrollSensitivity,
        terminalLigatures,
        terminalInlineImages,
      },
      terminalFontFamily,
    );
  }, [
    viewRef,
    terminalFontFamily,
    terminalScrollSensitivity,
    terminalFastScrollSensitivity,
    terminalTuiScrollSensitivity,
    terminalLigatures,
    terminalInlineImages,
  ]);
}
