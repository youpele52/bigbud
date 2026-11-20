import type { TerminalFinishedItem } from "@bigbud/contracts/workspace/terminal.activity.ts";
import {
  terminalFinishedCommand,
  terminalFinishedStatus,
} from "../components/sidebar/Sidebar.terminalFinished.logic";

export interface TerminalFinishedCopy {
  readonly title: string;
  readonly body: string;
  /** Toast severity: red for a non-zero exit, green for done. */
  readonly type: "error" | "success";
}

export function buildTerminalFinishedCopy(
  item: TerminalFinishedItem,
  threadTitle: string | undefined,
): TerminalFinishedCopy {
  const { failed, status } = terminalFinishedStatus(item);
  const title =
    item.source === "agent-hook"
      ? "Terminal agent finished"
      : failed
        ? "Terminal command failed"
        : "Terminal command finished";
  const parts = [terminalFinishedCommand(item), status, threadTitle].filter(
    (part): part is string => Boolean(part),
  );
  return { title, body: parts.join(" · "), type: failed ? "error" : "success" };
}

export function terminalFinishedNotificationKey(threadId: string, item: TerminalFinishedItem) {
  return `${threadId}:${item.terminalId}:${item.finishedAt}`;
}
