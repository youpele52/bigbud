import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { Entry } from "./remoteAgentConnectionPool.entry.ts";
import type { RemoteAgentRetirementFence } from "./remoteAgentRetirement.ts";
import { isSshTargetDisconnected } from "../ssh/sshTargetDisconnects.ts";

function readyConnection(entry: Entry | undefined): RemoteAgentConnection | null {
  if (!entry || entry.closed || entry.lifecycle.snapshot.state !== "ready") return null;
  return entry.lifecycle.connection;
}

/**
 * The ready connection for a target, whichever service opened it, or null. Never dials.
 * The entry `get` selected wins; otherwise the newest ready entry opened through `getBound`
 * (durable terminals, owned processes, shell-profile checks) whose runtime is not retiring.
 */
export function livePoolConnection(
  selected: ReadonlyMap<string, Entry>,
  entries: ReadonlyMap<string, Entry>,
  target: string,
  fence: Pick<RemoteAgentRetirementFence, "isRetiring">,
): RemoteAgentConnection | null {
  if (isSshTargetDisconnected(target)) return null;
  const preferred = readyConnection(selected.get(target));
  if (preferred) return preferred;
  let live: RemoteAgentConnection | null = null;
  for (const entry of entries.values()) {
    if (entry.executionTargetId !== target) continue;
    if (entry.binding && fence.isRetiring(entry.binding.runtime.generation)) continue;
    // Entries are kept in creation order, so a later ready entry is a newer runtime epoch.
    live = readyConnection(entry) ?? live;
  }
  return live;
}
