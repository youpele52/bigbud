import type { TerminalLimitCandidate } from "@bigbud/contracts/workspace/terminal.limit.ts";
import { create } from "zustand";

/** What a refused open knows; a caught `TerminalLimitError` satisfies it structurally. */
export interface TerminalLimitPromptInput {
  readonly limit: number;
  readonly liveCount: number;
  /** Null when every live terminal is visible, so none can be closed for the caller. */
  readonly candidate: TerminalLimitCandidate | null;
}

export type TerminalLimitDecision = "evict" | "cancel";

export interface TerminalLimitPromptRequest {
  readonly id: number;
  readonly input: TerminalLimitPromptInput;
}

interface TerminalLimitPromptState {
  /** FIFO; the dialog shows the head. */
  readonly queue: ReadonlyArray<TerminalLimitPromptRequest>;
}

/** Beyond this many waiting prompts a refusal is cancelled at once rather than queued. */
export const MAX_PENDING_TERMINAL_LIMIT_PROMPTS = 8;

export const useTerminalLimitPromptStore = create<TerminalLimitPromptState>(() => ({ queue: [] }));

const resolvers = new Map<number, (decision: TerminalLimitDecision) => void>();
let nextPromptId = 0;
let mountedHosts = 0;

/**
 * Asks whether to close the oldest terminal so a refused open can retry with `evict` (plan
 * §11.3). Resolves `"cancel"` at once when no dialog host is mounted or too many prompts wait.
 * Without a candidate the dialog explains the refusal and offers only Cancel.
 */
export function promptTerminalLimit(
  input: TerminalLimitPromptInput,
): Promise<TerminalLimitDecision> {
  const { queue } = useTerminalLimitPromptStore.getState();
  if (mountedHosts === 0 || queue.length >= MAX_PENDING_TERMINAL_LIMIT_PROMPTS) {
    return Promise.resolve("cancel");
  }
  const id = ++nextPromptId;
  return new Promise<TerminalLimitDecision>((resolve) => {
    resolvers.set(id, resolve);
    useTerminalLimitPromptStore.setState({ queue: [...queue, { id, input }] });
  });
}

/** Settles one prompt; a candidate-less prompt can only be cancelled. */
export function resolveTerminalLimitPrompt(id: number, decision: TerminalLimitDecision): void {
  const resolve = resolvers.get(id);
  if (!resolve) return;
  resolvers.delete(id);
  const { queue } = useTerminalLimitPromptStore.getState();
  const request = queue.find((entry) => entry.id === id);
  useTerminalLimitPromptStore.setState({ queue: queue.filter((entry) => entry.id !== id) });
  resolve(decision === "evict" && request?.input.candidate ? "evict" : "cancel");
}

function cancelAllTerminalLimitPrompts(): void {
  for (const { id } of useTerminalLimitPromptStore.getState().queue) {
    resolveTerminalLimitPrompt(id, "cancel");
  }
}

/** Called by the mounted dialog; the last host leaving cancels everything still waiting. */
export function registerTerminalLimitPromptHost(): () => void {
  mountedHosts += 1;
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    mountedHosts -= 1;
    if (mountedHosts === 0) cancelAllTerminalLimitPrompts();
  };
}
