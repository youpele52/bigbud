import type { OrchestrationEvent } from "@bigbud/contracts";

type ApplyEventBatch = (
  events: ReadonlyArray<OrchestrationEvent>,
  options: { readonly disposed?: (() => boolean) | undefined; readonly refresh?: boolean },
) => Promise<void>;

export function createPendingDomainEventQueue(applyEventBatch: ApplyEventBatch) {
  const pendingDomainEvents: OrchestrationEvent[] = [];
  let flushPendingDomainEventsScheduled = false;
  let pendingDomainEventFlush: Promise<void> | null = null;
  let pendingDomainEventScheduler: {
    disposed: () => boolean;
    onFailure: ((error: unknown) => void) | undefined;
  } | null = null;

  const flushPendingDomainEvents = (disposed: boolean): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pendingDomainEventFlush) return pendingDomainEventFlush;
    flushPendingDomainEventsScheduled = true;
    const flush = async () => {
      while (pendingDomainEvents.length > 0) {
        const batch = pendingDomainEvents.slice();
        await applyEventBatch(batch, {
          disposed: () => disposed,
        });
        pendingDomainEvents.splice(0, batch.length);
      }
    };
    pendingDomainEventFlush = flush().finally(() => {
      pendingDomainEventFlush = null;
      flushPendingDomainEventsScheduled = false;
      if (pendingDomainEvents.length > 0 && pendingDomainEventScheduler) {
        schedulePendingDomainEventFlush(
          pendingDomainEventScheduler.disposed,
          pendingDomainEventScheduler.onFailure,
        );
      }
    });
    return pendingDomainEventFlush;
  };

  const schedulePendingDomainEventFlush = (
    disposed: () => boolean,
    onFailure?: ((error: unknown) => void) | undefined,
  ) => {
    if (flushPendingDomainEventsScheduled) {
      return;
    }
    flushPendingDomainEventsScheduled = true;
    pendingDomainEventScheduler = { disposed, onFailure };
    queueMicrotask(() => {
      void flushPendingDomainEvents(disposed()).catch((error: unknown) => {
        onFailure?.(error);
      });
    });
  };

  return {
    flushPendingDomainEvents,
    schedulePendingDomainEventFlush,
    pushPendingDomainEvent: (event: OrchestrationEvent) => {
      pendingDomainEvents.push(event);
      if (pendingDomainEventScheduler && !flushPendingDomainEventsScheduled) {
        schedulePendingDomainEventFlush(
          pendingDomainEventScheduler.disposed,
          pendingDomainEventScheduler.onFailure,
        );
      }
    },
    cancel: () => {
      flushPendingDomainEventsScheduled = false;
      pendingDomainEvents.length = 0;
      pendingDomainEventScheduler = null;
    },
  };
}
