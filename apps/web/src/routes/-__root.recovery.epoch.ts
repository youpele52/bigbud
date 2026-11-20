import { createOrchestrationRecoveryCoordinator } from "../logic/orchestration/recovery.logic";
import { threadHydrationEventBuffer } from "../logic/orchestration/thread-hydration-events.logic";
import { useStore } from "../stores/main";
import { invalidateInFlightThreadHydrations } from "../stores/main/helpers.lazy.eviction.store";

const epochs = new WeakMap<object, string>();

/** Delivery baselines carry the authoritative epoch; ordinary refreshes do not reset fences. */
export function adoptDeliveryEpoch(
  recovery: ReturnType<typeof createOrchestrationRecoveryCoordinator>,
  serverEpoch: string | undefined,
) {
  if (serverEpoch === undefined || epochs.get(recovery) === serverEpoch) return recovery;
  if (useStore.getState().projectServerEpoch !== serverEpoch) {
    threadHydrationEventBuffer.clear();
    useStore.setState(invalidateInFlightThreadHydrations);
    useStore.getState().resetProjectCatalogEpoch(serverEpoch);
  }
  const next = createOrchestrationRecoveryCoordinator();
  epochs.set(next, serverEpoch);
  return next;
}
