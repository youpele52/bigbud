export type TerminalLayoutMode = "split" | "terminal-only" | "chat-only";

export interface TerminalLayoutSelection {
  readonly threadId: string;
  readonly epoch: number;
  readonly mode: TerminalLayoutMode;
}

export const TERMINAL_LAYOUT_LABELS: Record<TerminalLayoutMode, string> = {
  "chat-only": "Chat only",
  split: "Chat + terminal",
  "terminal-only": "Terminal only",
};

export function resolveEffectiveTerminalLayoutMode(input: {
  readonly terminalOpen: boolean;
  readonly activeThreadId: string;
  readonly activeEpoch: number;
  readonly selection: TerminalLayoutSelection;
}): TerminalLayoutMode {
  if (!input.terminalOpen) return "chat-only";
  if (input.selection.threadId !== input.activeThreadId) return "split";
  if (input.selection.epoch !== input.activeEpoch) return "split";
  return input.selection.mode;
}

export function resolveTerminalLayoutVisibility(mode: TerminalLayoutMode): {
  readonly chatVisible: boolean;
  readonly terminalPresentation: "split" | "fill" | "hidden";
} {
  if (mode === "terminal-only") {
    return { chatVisible: false, terminalPresentation: "fill" };
  }
  if (mode === "chat-only") {
    return { chatVisible: true, terminalPresentation: "hidden" };
  }
  return { chatVisible: true, terminalPresentation: "split" };
}
