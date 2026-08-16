import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import { useEffect } from "react";

import { readNativeApi } from "~/rpc/nativeApi";
import { useStore } from "~/stores/main";

/** Keeps the lightweight mascot window synchronized without mounting the full app shell. */
export function MascotStateCoordinator() {
  const applyOrchestrationEvents = useStore((state) => state.applyOrchestrationEvents);
  const syncServerReadModel = useStore((state) => state.syncServerReadModel);

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;

    let disposed = false;
    let snapshotSequence: number | null = null;
    let refreshPromise: Promise<void> | null = null;
    let refreshAgain = false;
    let retryTimer: number | null = null;
    const pendingEvents: OrchestrationEvent[] = [];

    const refresh = (): Promise<void> => {
      if (refreshPromise) {
        refreshAgain = true;
        return refreshPromise;
      }
      snapshotSequence = null;
      refreshAgain = false;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
      refreshPromise = api.orchestration
        .getSnapshot()
        .then((snapshot) => {
          if (disposed) return;
          syncServerReadModel(snapshot);
          snapshotSequence = snapshot.snapshotSequence;
          const replayable = pendingEvents
            .splice(0, pendingEvents.length)
            .filter((event) => event.sequence > snapshot.snapshotSequence)
            .toSorted((left, right) => left.sequence - right.sequence);
          for (const [index, event] of replayable.entries()) {
            if (event.sequence !== (snapshotSequence ?? 0) + 1) {
              pendingEvents.push(...replayable.slice(index));
              refreshAgain = true;
              return;
            }
            applyOrchestrationEvents([event]);
            snapshotSequence = event.sequence;
          }
        })
        .catch(() => {
          if (!disposed) {
            retryTimer = window.setTimeout(() => {
              retryTimer = null;
              void refresh();
            }, 1_000);
          }
        })
        .finally(() => {
          refreshPromise = null;
          if (!disposed && refreshAgain) {
            queueMicrotask(() => void refresh());
          }
        });
      return refreshPromise;
    };

    const unsubscribe = api.orchestration.onDomainEvent(
      (event) => {
        if (snapshotSequence === null) {
          pendingEvents.push(event);
          return;
        }
        if (event.sequence <= snapshotSequence) return;
        if (event.sequence !== snapshotSequence + 1) {
          pendingEvents.push(event);
          void refresh();
          return;
        }
        applyOrchestrationEvents([event]);
        snapshotSequence = event.sequence;
      },
      { onResubscribe: () => void refresh() },
    );
    void refresh();

    return () => {
      disposed = true;
      pendingEvents.length = 0;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [applyOrchestrationEvents, syncServerReadModel]);

  return null;
}
