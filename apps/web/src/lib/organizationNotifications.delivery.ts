import type { OrchestrationEvent } from "@bigbud/contracts";
import { toastManager } from "../components/ui/toast";
import { INYOSIRA_STATE_LABELS } from "../components/sidebar/Sidebar.inyosira.logic";
import { dispatchCommandWithOutcomeRecovery } from "./orchestrationCommandRecovery";
import { newCommandId } from "./utils";
import { readNativeApi } from "../rpc/nativeApi";
import {
  collectOrganizationNotifications,
  groupOrganizationNotifications,
  recentOrganizationNotifications,
} from "./organizationNotifications";

type Move = ReturnType<typeof collectOrganizationNotifications>[number];

/** Scoped to one delivery subscriber. Armed only while this connection is live; the sequence
 * frontier deduplicates and excludes everything delivered before live (bootstrap/replay).
 */
export function createOrganizationNotifications() {
  let pending: Move[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frontier: number | null = null;
  let latestServerAtMs = 0;
  const flush = () => {
    timer = undefined;
    const moves =
      frontier === null ? [] : recentOrganizationNotifications(pending, latestServerAtMs);
    pending = [];
    for (const group of groupOrganizationNotifications(moves)) {
      const first = group[0]!;
      const label = INYOSIRA_STATE_LABELS[first.payload.organization.state];
      toastManager.add({
        type: "success",
        title:
          group.length === 1 ? `Moved to ${label}` : `Moved ${group.length} threads to ${label}`,
        actionProps: {
          children: "Undo",
          onClick: () => {
            const api = readNativeApi();
            if (!api) return;
            void Promise.allSettled(
              group.map((event) =>
                dispatchCommandWithOutcomeRecovery(api, {
                  type: "thread.organization.move",
                  commandId: newCommandId(),
                  threadId: event.payload.threadId,
                  state: event.payload.automaticMove!.from,
                  expectedRevision: event.payload.organization.revision,
                  undoAutomaticMoveId: event.payload.automaticMove!.operationId,
                  createdAt: new Date().toISOString(),
                }),
              ),
            ).then((results) => {
              if (results.some((result) => result.status === "rejected")) {
                toastManager.add({
                  type: "error",
                  title: "Couldn't request Undo for every thread",
                });
              }
              // Accepted Undo can deliberately be a no-op. Only canonical events confirm moves.
            });
          },
        },
      });
    }
  };
  const disarm = () => {
    frontier = null;
    pending = [];
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return {
    /** Delivery is live (replay finished): only later sequences may notify. */
    arm(appliedSequence: number) {
      disarm();
      frontier = appliedSequence;
    },
    /** Connecting, reconnecting, degraded or fallback delivery: never toast. */
    disarm,
    add(events: readonly OrchestrationEvent[]) {
      if (frontier === null) return;
      for (const event of events) {
        const at = Date.parse(event.occurredAt);
        if (Number.isFinite(at)) latestServerAtMs = Math.max(latestServerAtMs, at);
      }
      const moves = collectOrganizationNotifications(events, frontier);
      for (const event of events) frontier = Math.max(frontier, event.sequence);
      pending.push(...moves);
      // Bounded coalescing across native's sequential proposals.
      if (pending.length >= 32) flush();
      else if (!timer && pending.length) timer = setTimeout(flush, 500);
    },
    dispose: disarm,
  };
}
