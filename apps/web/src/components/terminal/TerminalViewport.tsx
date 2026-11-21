import { useRef, useSyncExternalStore } from "react";
import { TerminalViewportSurface } from "./TerminalViewport.surface";
import type { TerminalViewportProps } from "./TerminalViewport.types";
import { terminalViewRegistry } from "./view-registry/TerminalViewRegistry";
import { useTerminalViewSlot } from "./view-registry/useTerminalViewSlot";

export { fitTerminalViewport } from "./TerminalViewport.fit";
export type { TerminalViewportProps } from "./TerminalViewport.types";

const serverHostAvailable = () => false;

/**
 * A pane slot. With the parking host mounted (the app root), the view lives in the registry and
 * survives this slot unmounting (thread switches, route gates, settings). Without it (isolated
 * tests, windows without the host) the view renders inline and dies with the slot.
 */
export function TerminalViewport(props: TerminalViewportProps) {
  const hostAvailable = useSyncExternalStore(
    terminalViewRegistry.subscribeHost,
    terminalViewRegistry.isHostAvailable,
    serverHostAvailable,
  );
  const slotRef = useRef<HTMLDivElement>(null);
  useTerminalViewSlot(slotRef, props, hostAvailable);
  if (!hostAvailable) return <TerminalViewportSurface {...props} />;
  return <div ref={slotRef} className="relative h-full w-full" data-terminal-view-slot="" />;
}
