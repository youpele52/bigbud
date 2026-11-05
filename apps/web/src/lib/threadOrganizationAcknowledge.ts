import type { ThreadId } from "@bigbud/contracts";

import { readNativeApi } from "../rpc/nativeApi";
import { useStore } from "../stores/main";
import { newCommandId } from "./utils";

/** Revisions already acknowledged, so a double click never dispatches twice. */
const acknowledged = new Set<string>();

/**
 * Called only on a deliberate open (row click, keyboard open, search or command-palette pick):
 * a Needs you thread the user chose to look at becomes Present. The move is fenced by the
 * revision the user saw, so a newer request or move made meanwhile wins. Route restoration,
 * hydration, hover, and status reads must never call this.
 */
export function acknowledgeThreadOpen(threadId: ThreadId): void {
  const organization = useStore.getState().sidebarThreadsById[threadId]?.organization;
  if (organization?.state !== "needs-you") return;
  const key = `${threadId}:${organization.revision}`;
  const api = readNativeApi();
  if (!api || acknowledged.has(key)) return;
  acknowledged.add(key);
  // A stale revision means the thread moved again meanwhile; that newer state is kept on purpose.
  void api.orchestration
    .dispatchCommand({
      type: "thread.organization.move",
      commandId: newCommandId(),
      threadId,
      state: "present",
      expectedRevision: organization.revision,
      createdAt: new Date().toISOString(),
    })
    .catch(() => acknowledged.delete(key));
}
