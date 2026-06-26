import {
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@bigbud/contracts";

import {
  coalesceOrchestrationUiEvents,
  shouldFlushOrchestrationEventImmediately,
} from "~/routes/-__root.orchestration-events";

import {
  applyOrchestrationEventToSnapshot,
  applyOrchestrationEventToThread,
} from "./mobileOrchestrationEvents.logic";

export const FALLBACK_REFETCH_DELAY_MS = 1_500;

type QueryKey = ReadonlyArray<string>;

type MobileQueryClient = {
  setQueryData<T>(queryKey: QueryKey, updater: (current: T | undefined) => T | undefined): void;
  invalidateQueries(input: { readonly queryKey: QueryKey }): Promise<unknown>;
};

type Scheduler = {
  readonly queueMicrotask: (callback: () => void) => void;
  readonly setTimeout: (callback: () => void, delayMs: number) => number;
  readonly clearTimeout: (timeoutId: number) => void;
};

function readThreadId(event: OrchestrationEvent): string | null {
  return "threadId" in event.payload ? event.payload.threadId : null;
}

function defaultScheduler(): Scheduler {
  return {
    queueMicrotask,
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timeoutId) => window.clearTimeout(timeoutId),
  };
}

export function createMobileOrchestrationSyncController(input: {
  readonly queryClient: MobileQueryClient;
  readonly sessionId: string;
  readonly scheduler?: Scheduler;
}) {
  const { queryClient, sessionId } = input;
  const scheduler = input.scheduler ?? defaultScheduler();
  const pendingEvents: OrchestrationEvent[] = [];
  let flushScheduled = false;
  let fallbackRefetchTimeoutId: number | null = null;

  const scheduleFallbackRefetch = () => {
    if (fallbackRefetchTimeoutId !== null) {
      return;
    }
    fallbackRefetchTimeoutId = scheduler.setTimeout(() => {
      fallbackRefetchTimeoutId = null;
      void queryClient.invalidateQueries({
        queryKey: ["mobile-snapshot", sessionId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["mobile-thread", sessionId],
      });
    }, FALLBACK_REFETCH_DELAY_MS);
  };

  const applyEvents = (events: ReadonlyArray<OrchestrationEvent>) => {
    const coalescedEvents = coalesceOrchestrationUiEvents(events);
    let handledEveryEvent = true;

    for (const event of coalescedEvents) {
      let eventHandled = false;
      const snapshotKey = ["mobile-snapshot", sessionId] as const;

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
        const threadKey = ["mobile-thread", sessionId, threadId] as const;
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

  return {
    queueEvent(event: OrchestrationEvent) {
      pendingEvents.push(event);
      if (shouldFlushOrchestrationEventImmediately(event)) {
        flushPendingEvents();
        return;
      }
      if (!flushScheduled) {
        flushScheduled = true;
        scheduler.queueMicrotask(flushPendingEvents);
      }
    },
    dispose() {
      if (fallbackRefetchTimeoutId !== null) {
        scheduler.clearTimeout(fallbackRefetchTimeoutId);
        fallbackRefetchTimeoutId = null;
      }
      flushPendingEvents();
    },
  };
}
