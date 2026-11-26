import type { ThreadId } from "@bigbud/contracts";

import type { TerminalAgentKind } from "../../stores/terminal/terminal.store.agentKind";
import type { ThreadTerminalLiveness } from "../../stores/terminal/terminalLiveness.store";
import { livenessForThreadPanes } from "./SidebarThreadRow.status";

/** Row tone: blue while a program runs, amber while an idle warning is pending, muted otherwise. */
export type ProjectTerminalState = "busy" | "idle" | "closing";

export interface ProjectTerminalRow {
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  /** The thread's Inyosira group label ("Present", "Later"…), for the row tooltip. */
  readonly group: string;
  readonly terminalId: string;
  /** The user's rename, else the agent's name, else the tab label ("Terminal 2"). */
  readonly title: string;
  readonly agent: TerminalAgentKind | null;
  readonly state: ProjectTerminalState;
  /** Whole minutes until the idle close, while `state` is `closing`. */
  readonly closesInMinutes: number | null;
}

/** How the popover names one terminal. */
export interface ProjectTerminalIdentity {
  readonly title: string;
  readonly agent: TerminalAgentKind | null;
}

export interface ProjectTerminalThread {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly group: string;
  readonly liveness: ThreadTerminalLiveness | undefined;
  /** The thread's panes in this client; empty means every live terminal is shown. */
  readonly panes: ReadonlyArray<string>;
}

/** Live terminals the sidebar counts for one thread, with the same pane rule as the thread row. */
export function visibleThreadLiveness(thread: ProjectTerminalThread): ThreadTerminalLiveness {
  return livenessForThreadPanes(thread.liveness ?? {}, thread.panes);
}

export function countProjectTerminals(threads: ReadonlyArray<ProjectTerminalThread>): number {
  let count = 0;
  for (const thread of threads) count += Object.keys(visibleThreadLiveness(thread)).length;
  return count;
}

function rowState(
  busy: boolean,
  idleClosesAt: string | null,
  nowMs: number,
): Pick<ProjectTerminalRow, "state" | "closesInMinutes"> {
  if (busy) return { state: "busy", closesInMinutes: null };
  const closesAt = idleClosesAt ? Date.parse(idleClosesAt) : Number.NaN;
  if (Number.isFinite(closesAt) && closesAt > nowMs)
    return {
      state: "closing",
      closesInMinutes: Math.max(1, Math.ceil((closesAt - nowMs) / 60_000)),
    };
  return { state: "idle", closesInMinutes: null };
}

/**
 * The popover's rows, flat: threads in the given order, terminals sorted by title within a thread.
 * Where a terminal belongs (group and thread) is left to the row tooltip.
 */
export function projectTerminalRows(input: {
  readonly threads: ReadonlyArray<ProjectTerminalThread>;
  readonly identify: (threadId: ThreadId, terminalId: string) => ProjectTerminalIdentity;
  readonly nowMs: number;
}): ProjectTerminalRow[] {
  const rows = input.threads.flatMap((thread) =>
    Object.entries(visibleThreadLiveness(thread))
      .map(([terminalId, entry]): ProjectTerminalRow => {
        const { title, agent } = input.identify(thread.threadId, terminalId);
        const { state, closesInMinutes } = rowState(entry.busy, entry.idleClosesAt, input.nowMs);
        return {
          threadId: thread.threadId,
          threadTitle: thread.title,
          group: thread.group,
          terminalId,
          title,
          agent,
          state,
          closesInMinutes,
        };
      })
      .toSorted((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true })),
  );
  return rows;
}

/** The dot's meaning, for its tooltip and screen readers. */
export function projectTerminalStateLabel(state: ProjectTerminalState): string {
  return state === "busy" ? "Busy" : state === "closing" ? "Idle, closing soon" : "Idle";
}

/** The row's second line: only the idle-close countdown, which the dot cannot convey. */
export function projectTerminalDetailText(row: ProjectTerminalRow): string | null {
  if (row.state !== "closing") return null;
  return `Closes in ${row.closesInMinutes} ${row.closesInMinutes === 1 ? "minute" : "minutes"}`;
}

/** Tooltip on the terminal's name: where it lives. */
export function projectTerminalLocationText(
  row: Pick<ProjectTerminalRow, "group" | "threadTitle">,
): string {
  const thread = row.threadTitle || "Untitled thread";
  return row.group ? `${row.group} · ${thread}` : thread;
}

export function idleProjectTerminals(
  rows: ReadonlyArray<ProjectTerminalRow>,
): ProjectTerminalRow[] {
  return rows.filter((row) => row.state !== "busy");
}
