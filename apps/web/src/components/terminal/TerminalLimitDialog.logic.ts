import { formatRelativeTime } from "../../utils/timestamp/timestamp.utils";
import type { TerminalNoticeNames } from "./terminalLifecycle.labels";
import type { TerminalLimitPromptInput } from "./terminalLimitPrompt";

export const TERMINAL_LIMIT_DIALOG_TITLE = "Terminal limit reached";
export const TERMINAL_LIMIT_EVICT_LABEL =
  "Yes, continue — the oldest terminal will be closed whether it is active or not";

export interface TerminalLimitDialogCopy {
  readonly body: string;
  /** Null when no terminal can be closed for the caller (all live terminals are visible). */
  readonly candidateLine: string | null;
}

function lastUsedLabel(lastUsedAt: string): string {
  const { value } = formatRelativeTime(lastUsedAt);
  return value === "just now" ? "just now" : `${value} ago`;
}

/** Copy for the limit dialog (plan §11.3). */
export function describeTerminalLimitPrompt(
  input: TerminalLimitPromptInput,
  candidateNames: TerminalNoticeNames | null,
): TerminalLimitDialogCopy {
  const count = input.liveCount === 1 ? "1 terminal" : `${input.liveCount} terminals`;
  if (!input.candidate || !candidateNames) {
    return {
      body: `You have ${count} running, the most bigbud allows. Every one of them is visible right now, so none can be closed for you. Close a terminal, then try again.`,
      candidateLine: null,
    };
  }
  const busy = input.candidate.busy ? ", busy" : "";
  return {
    body: `You have ${count} running, the most bigbud allows. Opening another one requires closing one first.`,
    candidateLine: `Oldest: “${candidateNames.label}” in “${candidateNames.thread}”, last used ${lastUsedLabel(input.candidate.lastUsedAt)}${busy}.`,
  };
}
