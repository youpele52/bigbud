import type { TerminalFinishedItem } from "@bigbud/contracts/workspace/terminal.activity.ts";
import { formatRelativeTimeLabel } from "../../utils/timestamp";

export interface TerminalFinishedPresentation {
  readonly command: string;
  readonly status: string;
  readonly failed: boolean;
  readonly ago: string;
  readonly more: number;
}

export function terminalFinishedCommand(item: TerminalFinishedItem): string {
  if (item.command) return item.command;
  return item.source === "agent-hook" ? "Agent turn" : "Command";
}

/** "exit N" for a non-zero exit (a failure); "done" for zero or an unknown exit code. */
export function terminalFinishedStatus(item: TerminalFinishedItem) {
  const failed = item.exitCode !== null && item.exitCode !== 0;
  return { failed, status: failed ? `exit ${item.exitCode}` : "done" };
}

/** The newest finished item of a thread, for its Needs you row. */
export function presentTerminalFinished(
  items: ReadonlyArray<TerminalFinishedItem> | undefined,
): TerminalFinishedPresentation | null {
  if (!items || items.length === 0) return null;
  const latest = items.reduce((newest, item) =>
    Date.parse(item.finishedAt) > Date.parse(newest.finishedAt) ? item : newest,
  );
  return {
    command: terminalFinishedCommand(latest),
    ...terminalFinishedStatus(latest),
    ago: formatRelativeTimeLabel(latest.finishedAt),
    more: items.length - 1,
  };
}
