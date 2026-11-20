import type { TerminalWorkActivity } from "@bigbud/contracts/workspace/terminal.activity.ts";
import type { SidebarThreadSummary } from "../../models/types";
import type { AppState } from "./main.store";

function laterTimestamp(
  left: string | null | undefined,
  right: string | null | undefined,
): string | null {
  if (!left) return right ?? null;
  if (!right) return left;
  return right > left ? right : left;
}

/**
 * Terminal recency and finished items come from the server (summaries and `workActivity` items),
 * never from thread events, so every summary rebuilt from a thread keeps the previous values.
 */
export function withTerminalWork(
  next: SidebarThreadSummary,
  previous: SidebarThreadSummary | undefined,
): SidebarThreadSummary {
  if (!previous) return next;
  const latestTerminalActivityAt = laterTimestamp(
    previous.latestTerminalActivityAt,
    next.latestTerminalActivityAt,
  );
  const terminalFinished = next.terminalFinished ?? previous.terminalFinished;
  return {
    ...next,
    ...(latestTerminalActivityAt ? { latestTerminalActivityAt } : {}),
    ...(terminalFinished ? { terminalFinished } : {}),
  };
}

export function preserveTerminalWork(
  next: Record<string, SidebarThreadSummary>,
  previous: Record<string, SidebarThreadSummary>,
): Record<string, SidebarThreadSummary> {
  for (const [threadId, summary] of Object.entries(next))
    next[threadId] = withTerminalWork(summary, previous[threadId]);
  return next;
}

/** A live recency or finished-item change for one loaded thread; unknown threads are ignored. */
export function applyTerminalWorkActivity(state: AppState, item: TerminalWorkActivity): AppState {
  const summary = state.sidebarThreadsById[item.threadId];
  if (!summary) return state;
  let next = summary;
  if (item.latestActivityAt !== undefined) {
    const latest = laterTimestamp(summary.latestTerminalActivityAt, item.latestActivityAt);
    if (latest !== (summary.latestTerminalActivityAt ?? null))
      next = { ...next, latestTerminalActivityAt: latest };
  }
  if (item.finished !== undefined) {
    const others = (summary.terminalFinished ?? []).filter(
      (finished) => finished.terminalId !== item.terminalId,
    );
    const terminalFinished = item.finished ? [...others, item.finished] : others;
    if (terminalFinished.length !== (summary.terminalFinished ?? []).length || item.finished)
      next = { ...next, terminalFinished };
  }
  if (next === summary) return state;
  return { ...state, sidebarThreadsById: { ...state.sidebarThreadsById, [item.threadId]: next } };
}
