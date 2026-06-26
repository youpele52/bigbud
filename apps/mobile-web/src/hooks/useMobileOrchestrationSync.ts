import {
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@bigbud/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  coalesceOrchestrationUiEvents,
  shouldFlushOrchestrationEventImmediately,
} from "~/routes/-__root.orchestration-events";

import {
  applyOrchestrationEventToSnapshot,
  applyOrchestrationEventToThread,
} from "../logic/mobileOrchestrationEvents.logic";
import type { StoredMobileSession } from "../lib/mobileSession";
import type { MobileRpcClient } from "../lib/mobileRpc";

const FALLBACK_REFETCH_DELAY_MS = 1_500;

function readThreadId(event: OrchestrationEvent): string | null {
  return "threadId" in event.payload ? event.payload.threadId : null;
}

export function useMobileOrchestrationSync(
  session: StoredMobileSession | null,
  client: MobileRpcClient | null,
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!client || !session) {
      return;
    }

    const pendingEvents: OrchestrationEvent[] = [];
    let flushScheduled = false;
    let fallbackRefetchTimeoutId: number | null = null;

    const scheduleFallbackRefetch = () => {
      if (fallbackRefetchTimeoutId !== null) {
        return;
      }
      fallbackRefetchTimeoutId = window.setTimeout(() => {
        fallbackRefetchTimeoutId = null;
        void queryClient.invalidateQueries({
          queryKey: ["mobile-snapshot", session.sessionId],
        });
        void queryClient.invalidateQueries({
          queryKey: ["mobile-thread", session.sessionId],
        });
      }, FALLBACK_REFETCH_DELAY_MS);
    };

    const applyEvents = (events: ReadonlyArray<OrchestrationEvent>) => {
      const coalescedEvents = coalesceOrchestrationUiEvents(events);
      let handledEveryEvent = true;

      for (const event of coalescedEvents) {
        let eventHandled = false;
        const snapshotKey = ["mobile-snapshot", session.sessionId] as const;

        queryClient.setQueryData<OrchestrationReadModel>(snapshotKey, (current) => {
          if (!current) {
            return current;
          }
          const result = applyOrchestrationEventToSnapshot(current, event);
          if (result.changed) {
            eventHandled = true;
          }
          return result.snapshot;
        });

        const threadId = readThreadId(event);
        if (threadId) {
          const threadKey = ["mobile-thread", session.sessionId, threadId] as const;
          queryClient.setQueryData<OrchestrationThread>(threadKey, (current) => {
            if (!current) {
              return current;
            }
            const nextThread = applyOrchestrationEventToThread(current, event);
            if (nextThread !== null) {
              eventHandled = true;
              return nextThread;
            }
            return current;
          });
        }

        if (!eventHandled) {
          handledEveryEvent = false;
        }
      }

      if (!handledEveryEvent) {
        scheduleFallbackRefetch();
      }
    };

    const flushPendingEvents = () => {
      flushScheduled = false;
      if (pendingEvents.length === 0) {
        return;
      }
      const events = pendingEvents.splice(0, pendingEvents.length);
      applyEvents(events);
    };

    const queueEvent = (event: OrchestrationEvent) => {
      pendingEvents.push(event);
      if (shouldFlushOrchestrationEventImmediately(event)) {
        flushPendingEvents();
        return;
      }
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flushPendingEvents);
      }
    };

    const unsubscribe = client.onDomainEvent((event) => {
      queueEvent(event as OrchestrationEvent);
    });

    return () => {
      unsubscribe();
      if (fallbackRefetchTimeoutId !== null) {
        window.clearTimeout(fallbackRefetchTimeoutId);
      }
      flushPendingEvents();
    };
  }, [client, queryClient, session]);
}
