import { ThreadId } from "@bigbud/contracts/core/baseSchemas";

import { useStore } from "../../stores/main";
import { useTerminalStateStore } from "../../stores/terminal";
import { terminalSearchLabel } from "../layout/SearchPalette.terminalResults.logic";

export interface TerminalNoticeNames {
  /** The tab label ("Terminal 2", or the user's rename). */
  readonly label: string;
  /** The thread's title, or "a thread" when it is not loaded. */
  readonly thread: string;
}

const UNKNOWN_THREAD_TITLE = "a thread";

/** Names a terminal for lifecycle copy from the current stores, never failing. */
export function resolveTerminalNoticeNames(
  threadId: string | undefined,
  terminalId: string | undefined,
): TerminalNoticeNames {
  if (!threadId) return { label: "Terminal", thread: UNKNOWN_THREAD_TITLE };
  const id = ThreadId.makeUnsafe(threadId);
  const title = useStore.getState().sidebarThreadsById[id]?.title?.trim();
  return {
    label: terminalId
      ? terminalSearchLabel(useTerminalStateStore.getState(), id, terminalId)
      : "Terminal",
    thread: title || UNKNOWN_THREAD_TITLE,
  };
}
