import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";

import type { OwnedPtyDrainingHostNotice } from "../Services/OwnedPtyRuntime.ts";
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
    entries.push({
      threadId: session.threadId,
      terminalId: session.terminalId,
      ...terminalHostInventoryFields(session),
    });
  }
  for (const entry of roster) {
    if (seen.has(toSessionKey(entry.threadId, entry.terminalId))) continue;
    entries.push({
      threadId: entry.threadId,
      terminalId: entry.terminalId,
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
