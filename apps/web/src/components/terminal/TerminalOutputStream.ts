import type { TerminalEvent } from "@bigbud/contracts/workspace/terminal.ts";

type Listener = (event: TerminalEvent) => void;
const listeners = new Map<string, Set<Listener>>();
function key(threadId: string, terminalId: string): string {
  return JSON.stringify([threadId, terminalId]);
}

/** Transient synchronous delivery; the persisted UI ring is not an output transport. */
export function publishTerminalOutput(event: TerminalEvent): void {
  for (const listener of listeners.get(key(event.threadId, event.terminalId)) ?? [])
    listener(event);
}

export function subscribeTerminalOutput(
  threadId: string,
  terminalId: string,
  listener: Listener,
): () => void {
  const id = key(threadId, terminalId);
  const subscribers = listeners.get(id) ?? new Set<Listener>();
  subscribers.add(listener);
  listeners.set(id, subscribers);
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) listeners.delete(id);
  };
}
