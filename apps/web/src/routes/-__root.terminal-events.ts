import type { NativeApi, TerminalEvent } from "@bigbud/contracts";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import type { TerminalWorkActivity } from "@bigbud/contracts/workspace/terminal.activity.ts";

/** Keep batching ordered across subscription inventories, including same-tick resubscriptions. */
export function subscribeGlobalTerminalState(input: {
  terminal: Pick<NativeApi["terminal"], "onEvent">;
  isArchived: (threadId: string) => boolean;
  applyEvents: (events: ReadonlyArray<TerminalEvent>) => void;
  reconcileInventory: (inventory: TerminalSessionInventory) => void;
  /** Terminal recency and finished work; applied in arrival order, never batched. */
  applyWork?: (item: TerminalWorkActivity) => void;
}): () => void {
  const pending: TerminalEvent[] = [];
  let disposed = false;
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (!disposed && pending.length > 0) input.applyEvents(pending.splice(0));
  };
  const unsubscribe = input.terminal.onEvent(
    (event) => {
      if (disposed || input.isArchived(event.threadId)) return;
      pending.push(event);
      if (pending.length >= 128) flush();
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(flush);
    },
    {
      onInventory: (inventory) => {
        if (disposed) return;
        // Older queued activity must not be applied after authoritative absence reconciliation.
        flush();
        input.reconcileInventory(inventory);
      },
      ...(input.applyWork
        ? {
            onWork: (item: TerminalWorkActivity) => {
              if (!disposed) input.applyWork?.(item);
            },
          }
        : {}),
    },
  );
  return () => {
    disposed = true;
    pending.length = 0;
    unsubscribe();
  };
}
