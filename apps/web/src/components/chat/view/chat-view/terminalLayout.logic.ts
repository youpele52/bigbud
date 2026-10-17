import type { TerminalLayoutMode } from "~/stores/terminal/terminal.store.layout";

export type { TerminalLayoutMode };

export const TERMINAL_LAYOUT_LABELS: Record<TerminalLayoutMode, string> = {
  "chat-only": "Chat only",
  split: "Chat + terminal",
  "terminal-only": "Terminal only",
};

export function resolveEffectiveTerminalLayoutMode(input: {
  readonly terminalOpen: boolean;
  readonly selection: TerminalLayoutMode | undefined;
}): TerminalLayoutMode {
  if (!input.terminalOpen) return "chat-only";
  return input.selection ?? "split";
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
