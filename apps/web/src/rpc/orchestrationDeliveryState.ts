import { useSyncExternalStore } from "react";
import type { OrchestrationDeliveryLifecycle } from "@bigbud/contracts";

let snapshot: OrchestrationDeliveryLifecycle | null = null;
const listeners = new Set<() => void>();

export function setOrchestrationDeliveryLifecycle(
  lifecycle: OrchestrationDeliveryLifecycle | null,
): void {
  snapshot = lifecycle;
  for (const listener of listeners) listener();
}

export function getOrchestrationDeliveryLifecycle(): OrchestrationDeliveryLifecycle | null {
  return snapshot;
}

export function useOrchestrationDeliveryLifecycle(): OrchestrationDeliveryLifecycle | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getOrchestrationDeliveryLifecycle,
    getOrchestrationDeliveryLifecycle,
  );
}

export function resetOrchestrationDeliveryLifecycleForTests(): void {
  setOrchestrationDeliveryLifecycle(null);
}
