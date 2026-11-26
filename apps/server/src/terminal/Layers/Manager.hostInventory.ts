import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";

import type {
  OwnedPtyDrainingHostNotice,
  OwnedPtyHostGenerationReplay,
} from "../Services/OwnedPtyRuntime.ts";
import type { TerminalSessionInventoryEntry } from "./Manager.host.types.ts";
import type { TerminalHostRosterEntry } from "./Manager.hostRoster.ts";
import { toSessionKey } from "./Manager.shell";
import type { TerminalSessionState } from "./Manager.types.ts";

/** Sidebar facts of a host session (§8.5, §11.2); in-process sessions add nothing. */
export function terminalHostInventoryFields(
  session: TerminalSessionState,
): Omit<TerminalSessionInventoryEntry, "threadId" | "terminalId"> {
  const host = session.host;
  if (!host) return {};
  const running = session.status === "running";
  return {
    activity: running && host.activity?.sidebarBusy ? "busy" : "quiet",
    restorable: running && host.restorable,
    ...(running && host.idleClosesAt ? { idleClosesAt: host.idleClosesAt } : {}),
  };
}

/** Only a starting or running process is live; exited and failed sessions stay members. */
const sessionIsLive = (session: TerminalSessionState) =>
  session.status === "running" || session.status === "starting";

/** One manager session's inventory entry; in-process running sessions stay exactly as before. */
export function terminalInventoryEntry(
  session: TerminalSessionState,
): TerminalSessionInventoryEntry {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    ...(sessionIsLive(session) ? {} : { live: false }),
    ...terminalHostInventoryFields(session),
  };
}

/**
 * Manager sessions plus host-owned panes no view has reopened since a backend restart, so
 * restored panes are kept (and reattach) instead of being dropped as absent.
 */
export function terminalInventorySessions(
  sessions: Iterable<TerminalSessionState>,
  roster: ReadonlyArray<TerminalHostRosterEntry>,
): TerminalSessionInventoryEntry[] {
  const entries: TerminalSessionInventoryEntry[] = [];
  const seen = new Set<string>();
  for (const session of sessions) {
    seen.add(toSessionKey(session.threadId, session.terminalId));
    entries.push(terminalInventoryEntry(session));
  }
  for (const entry of roster) {
    if (seen.has(toSessionKey(entry.threadId, entry.terminalId))) continue;
    entries.push({
      threadId: entry.threadId,
      terminalId: entry.terminalId,
      // A lost PTY keeps its pane (read-only last screen) but is not a running terminal.
      ...(entry.lost ? { live: false } : {}),
      activity: !entry.lost && entry.activityState === "busy" ? "busy" : "quiet",
    });
  }
  return entries;
}

/** The one-time amber toast for an old host that can't be reconnected (§7.3 item 5). */
export function legacyTerminalHostNotice(
  notice: OwnedPtyDrainingHostNotice,
  createdAt: string,
): TerminalLifecycleNotice {
  return {
    type: "lifecycleNotice",
    noticeId: `legacy-host:${notice.generation}`,
    kind: "legacyHostUnreachable",
    createdAt,
  };
}

/** Closes that happened because a terminal sat unused (idle, or orphaned in default mode). */
const OFFLINE_CLOSE_KINDS: ReadonlySet<string> = new Set(["idle_closed", "orphan_closed"]);

/**
 * The single "While bigbud was closed, n terminals were closed" summary (plan §11.3) from the
 * replay at adoption. A first sight of a generation only sets its baseline. After a ring gap the
 * count covers the notices the host still had. Its id names the cursors it covers, so a replay
 * of the same span never raises a second toast.
 */
export function offlineClosedNotice(
  replays: ReadonlyArray<OwnedPtyHostGenerationReplay>,
  createdAt: string,
): TerminalLifecycleNotice | undefined {
  const counted = replays.filter((replay) => !replay.baseline);
  const count = counted.reduce(
    (total, replay) =>
      total + replay.notices.filter((notice) => OFFLINE_CLOSE_KINDS.has(notice.kind)).length,
    0,
  );
  if (count === 0) return undefined;
  const span = counted
    .map(
      (replay) => `${replay.generation}.${replay.agentEpoch.slice(0, 12)}.${replay.lastNoticeId}`,
    )
    .join(",");
  return {
    type: "lifecycleNotice",
    noticeId: `offline:${span}`.slice(0, 128),
    kind: "offlineClosed",
    count,
    createdAt,
  };
}
