import type { TerminalWorkActivity } from "@bigbud/contracts/workspace/terminal.activity.ts";

type Listener = (item: TerminalWorkActivity) => void;
const listeners = new Set<Listener>();

/** Live terminal work items from the global terminal stream, for notification consumers. */
export function emitTerminalWorkActivity(item: TerminalWorkActivity): void {
  for (const listener of listeners) listener(item);
}

export function onTerminalWorkActivity(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
