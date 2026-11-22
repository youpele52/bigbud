import type { NativeApi, TerminalEvent } from "@bigbud/contracts";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import type { TerminalWorkActivity } from "@bigbud/contracts/workspace/terminal.activity.ts";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";

import { createTerminalLifecycleNotices } from "../components/terminal/terminalLifecycleNotices";
import { toastManager } from "../components/ui/toast.manager";
import {
  applyTerminalLivenessEvents,
  applyTerminalLivenessNotice,
  reconcileTerminalLivenessInventory,
} from "../stores/terminal/terminalLiveness.store";
import { terminalNoticeEndsPane } from "../stores/terminal/terminal.store.ended";

/** Keep batching ordered across subscription inventories, including same-tick resubscriptions. */
export function subscribeGlobalTerminalState(input: {
  terminal: Pick<NativeApi["terminal"], "onEvent">;
  isArchived: (threadId: string) => boolean;
  applyEvents: (events: ReadonlyArray<TerminalEvent>) => void;
  reconcileInventory: (inventory: TerminalSessionInventory) => void;
  /** Terminal recency and finished work; applied in arrival order, never batched. */
  applyWork?: (item: TerminalWorkActivity) => void;
  /** Lifecycle notices (idle warnings, closes, limit refusals); applied in arrival order. */
  applyLifecycle?: (notice: TerminalLifecycleNotice) => void;
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
      ...(input.applyLifecycle
        ? {
            onLifecycle: (notice: TerminalLifecycleNotice) => {
              if (!disposed) input.applyLifecycle?.(notice);
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

/**
 * The app's terminal subscription: pane state, sidebar liveness and, in the renderer that owns
 * notifications, lifecycle toasts. Liveness follows the same ordered pipeline as pane state.
 */
export function subscribeAppTerminalState(input: {
  terminal: Pick<
    NativeApi["terminal"],
    "onEvent" | "keepOpen" | "retrySetup" | "closeDrainingHosts"
  >;
  isArchived: (threadId: string) => boolean;
  applyEvents: (events: ReadonlyArray<TerminalEvent>) => void;
  reconcileInventory: (inventory: TerminalSessionInventory) => void;
  applyWork: (item: TerminalWorkActivity) => void;
  /** False in renderers that must not toast (the compact chat window). */
  showLifecycleNotices: boolean;
  /** A host close (idle, memory, limit, orphan, quit) removes the pane, mounted or not (§11.1). */
  removeEndedTerminal?: (threadId: string, terminalId: string) => void;
}): () => void {
  const notices = input.showLifecycleNotices
    ? createTerminalLifecycleNotices({ terminal: input.terminal, toasts: toastManager })
    : null;
  const unsubscribe = subscribeGlobalTerminalState({
    terminal: input.terminal,
    isArchived: input.isArchived,
    applyEvents: (events) => {
      input.applyEvents(events);
      applyTerminalLivenessEvents(events);
    },
    reconcileInventory: (inventory) => {
      input.reconcileInventory(inventory);
      reconcileTerminalLivenessInventory(inventory);
    },
    applyWork: input.applyWork,
    applyLifecycle: (notice) => {
      applyTerminalLivenessNotice(notice);
      notices?.handle(notice);
      if (notice.threadId && notice.terminalId && terminalNoticeEndsPane(notice))
        input.removeEndedTerminal?.(notice.threadId, notice.terminalId);
    },
  });
  return () => {
    unsubscribe();
    notices?.dispose();
  };
}
