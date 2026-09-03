export type TerminalLayoutMode = "split" | "terminal-only" | "chat-only";

export interface TerminalLayoutSelection {
  readonly threadId: string;
  readonly epoch: number;
  readonly mode: TerminalLayoutMode;
}

const NEXT_MODE: Record<TerminalLayoutMode, TerminalLayoutMode> = {
  split: "terminal-only",
  "terminal-only": "chat-only",
  "chat-only": "split",
};

const NEXT_ACTION_LABEL: Record<TerminalLayoutMode, string> = {
  split: "Show terminal only",
  "terminal-only": "Show chat only",
  "chat-only": "Show split chat and terminal",
};

export function cycleTerminalLayoutMode(mode: TerminalLayoutMode): TerminalLayoutMode {
  return NEXT_MODE[mode];
}

export function terminalLayoutNextActionLabel(mode: TerminalLayoutMode): string {
  return NEXT_ACTION_LABEL[mode];
}

export function resolveEffectiveTerminalLayoutMode(input: {
  readonly terminalOpen: boolean;
  readonly activeThreadId: string;
  readonly activeEpoch: number;
  readonly selection: TerminalLayoutSelection;
}): TerminalLayoutMode {
  if (!input.terminalOpen) return "split";
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
