import { resetSessionRuntimeState } from "./Manager.session.state";
import type { TerminalSessionState } from "./Manager.types";

/** A failed replacement must not destroy the previous bounded transcript. */
export function prepareTerminalLaunchHistory(session: TerminalSessionState, recoverOnly: boolean) {
  const previous = {
    history: session.history,
    historyTruncated: session.historyTruncated,
    historyUnavailable: session.historyUnavailable,
    historyBytes: session.historyBytes,
    historyNewlines: session.historyNewlines,
    historyTail: session.historyTail,
  };
  if (!recoverOnly) resetSessionRuntimeState(session);
  return () => {
    if (session.status !== "running") Object.assign(session, previous);
  };
}
