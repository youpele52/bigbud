import type { OrchestrationEvent } from "@bigbud/contracts";

import type { readNativeApi } from "../rpc/nativeApi";
import { useStore } from "../stores/main";
import { retryTransportRecoveryOperation } from "../logic/orchestration";

type Api = NonNullable<ReturnType<typeof readNativeApi>>;

export function shouldRefreshSidebarCatalog(event: OrchestrationEvent): boolean {
  switch (event.type) {
    case "thread.created":
    case "thread.deletion-requested":
    case "thread.deletion-failed":
    case "thread.deleted":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.meta-updated":
    case "thread.reverted":
      return true;
    case "thread.message-sent":
      return event.payload.role === "user";
    default:
      return false;
  }
}

export function getHighestSequence(events: ReadonlyArray<OrchestrationEvent>): number {
  return events.reduce((highest, event) => Math.max(highest, event.sequence), 0);
}

export function createSidebarCatalogRefresher(api: Api) {
  let requested = false;
  let minimumSequence = 0;
  let inFlight: Promise<boolean> | null = null;

  const refresh = (disposed: () => boolean, requiredSequence = 0): Promise<boolean> => {
    requested = true;
    minimumSequence = Math.max(minimumSequence, requiredSequence);
    if (inFlight !== null) return inFlight;

    const operation = (async () => {
      let refreshed = true;
      while (requested) {
        requested = false;
        const targetSequence = minimumSequence;
        minimumSequence = 0;
        let applied = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const sidebarCatalog = await retryTransportRecoveryOperation(
              () => api.orchestration.getSidebarThreadCatalog(),
              { shouldAbort: disposed },
            );
            if (disposed()) return false;
            if (sidebarCatalog.projectionSequence < targetSequence) {
              await new Promise<void>((resolve) => setTimeout(resolve, 10));
              continue;
            }
            useStore.getState().syncSidebarCatalog(sidebarCatalog);
            applied = true;
            break;
          } catch {
            break;
          }
        }
        if (!applied) refreshed = false;
      }
      return refreshed;
    })();
    inFlight = operation;
    void operation.finally(() => {
      if (inFlight === operation) inFlight = null;
    });
    return operation;
  };

  return {
    refresh,
    cancel: () => {
      requested = false;
      minimumSequence = 0;
    },
  };
}
