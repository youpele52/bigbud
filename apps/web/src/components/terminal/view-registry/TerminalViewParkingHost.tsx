import { memo, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useTerminalStateStore } from "../../../stores/terminal/terminal.store";
import type { TerminalStateStoreState } from "../../../stores/terminal/terminal.store.types";
import { TerminalViewportErrorBoundary } from "../TerminalViewportErrorBoundary";
import { TerminalViewportSurface } from "../TerminalViewport.surface";
import { terminalViewRegistry } from "./TerminalViewRegistry";

const NO_ENTRIES: ReadonlyArray<{ readonly key: string; readonly host: HTMLElement }> = [];

/** A pane exists while its thread's drawer or panel lists it; anything else may be disposed. */
export function isTerminalPaneListed(
  state: Pick<TerminalStateStoreState, "terminalStateByThreadId" | "panelTerminalStateByThreadId">,
  threadId: string,
  terminalId: string,
): boolean {
  const id = threadId as keyof typeof state.terminalStateByThreadId;
  return Boolean(
    state.terminalStateByThreadId[id]?.terminalIds.includes(terminalId) ||
    state.panelTerminalStateByThreadId[id]?.terminalIds.includes(terminalId),
  );
}

const TerminalViewPortal = memo(function TerminalViewPortal({
  viewKey,
  host,
}: {
  readonly viewKey: string;
  readonly host: HTMLElement;
}) {
  const render = useSyncExternalStore(
    (listener) => terminalViewRegistry.subscribeEntry(viewKey, listener),
    () => terminalViewRegistry.getEntryRender(viewKey),
  );
  if (!render) return null;
  return createPortal(
    <TerminalViewportErrorBoundary terminalLabel={render.terminalLabel}>
      <TerminalViewportSurface {...render} />
    </TerminalViewportErrorBoundary>,
    host,
  );
});

/**
 * Mounted once at the app root, above route and project gates. Renders every live terminal view
 * through a portal into its registry host, and owns the hidden holder that released views wait in.
 * The holder keeps real layout (`visibility: hidden`, not `display: none`) so xterm measurements
 * stay valid, and is inert so a parked view can never take focus.
 */
export function TerminalViewParkingHost() {
  terminalViewRegistry.markHostRendered();
  const holderRef = useRef<HTMLDivElement>(null);
  const entries = useSyncExternalStore(
    terminalViewRegistry.subscribe,
    terminalViewRegistry.getMountedEntries,
    () => NO_ENTRIES,
  );

  useLayoutEffect(() => {
    const holder = holderRef.current;
    if (!holder) return;
    return terminalViewRegistry.attachHolder(holder);
  }, []);

  useEffect(() => {
    const isListed = (threadId: string, terminalId: string) =>
      isTerminalPaneListed(useTerminalStateStore.getState(), threadId, terminalId);
    terminalViewRegistry.setListedPredicate(isListed);
    return useTerminalStateStore.subscribe((state, previous) => {
      if (
        state.terminalStateByThreadId !== previous.terminalStateByThreadId ||
        state.panelTerminalStateByThreadId !== previous.panelTerminalStateByThreadId
      )
        terminalViewRegistry.prune();
    });
  }, []);

  return (
    <>
      <div
        ref={holderRef}
        aria-hidden
        inert
        data-terminal-view-holder=""
        className="pointer-events-none invisible fixed top-0 left-0 h-0 w-0 overflow-hidden"
      />
      {entries.map((entry) => (
        <TerminalViewPortal key={entry.key} viewKey={entry.key} host={entry.host} />
      ))}
    </>
  );
}
