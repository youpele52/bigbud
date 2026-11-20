import {
  TERMINAL_FINISHED_MIN_DURATION_MS,
  TERMINAL_STOPPED_EXIT_CODE,
} from "@bigbud/contracts/workspace/terminal.activity.ts";
import type { TerminalFinishedCandidate } from "./terminalWorkSignalReader.ts";

export type TerminalFinishedDecision = "raise" | "short" | "stopped" | "viewed";

/**
 * Whether finished work needs the user. Commands must run at least a minute; a Ctrl-C stop (130)
 * is "stopped"; an agent hook marker always qualifies; nothing is raised for a viewed pane.
 */
export function decideTerminalFinished(
  candidate: TerminalFinishedCandidate,
  viewed: boolean,
): TerminalFinishedDecision {
  if (candidate.source !== "agent-hook") {
    if (candidate.exitCode === TERMINAL_STOPPED_EXIT_CODE) return "stopped";
    if (candidate.durationMs === null || candidate.durationMs < TERMINAL_FINISHED_MIN_DURATION_MS)
      return "short";
  }
  return viewed ? "viewed" : "raise";
}
