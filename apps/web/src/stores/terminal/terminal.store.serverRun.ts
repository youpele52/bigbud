/**
 * Panes across a backend restart without a page reload (plan D1, §11.1, §14). The server's
 * in-memory sessions and host-closed tombstones are gone after a restart or crash, so a plain
 * open of a pane the host closed meanwhile could spawn a fresh shell. When the welcome after a
 * reconnect names a new `serverRunId`, every pane on both surfaces becomes `restored`, exactly as
 * after a reload: its next open only reattaches, a pane with nothing to attach is dropped, and
 * the next authoritative inventory (or one already received on the new connection) prunes
 * absent ones.
 *
 * Opens wait for that decision: from a disconnect until the next welcome (bounded), a view that
 * resynchronises must not pick its open options from the old run.
 *
 * @module terminal.store.serverRun
 */
import { normalizeThreadTerminalState, type ThreadTerminalState } from "./helpers.store";
import {
  pruneRestoredPanesForInventory,
  readLatestTerminalInventory,
  terminalInventoryGeneration,
} from "./terminal.store.inventory";
import type { TerminalStateStoreState } from "./terminal.store.types";

/** An open waits at most this long for the welcome after a reconnect, then goes ahead. */
export const TERMINAL_SERVER_RUN_WAIT_MS = 5_000;

interface PendingRun {
  readonly settled: Promise<void>;
  readonly release: () => void;
  /** Inventories remembered before the disconnect; a later one came from the new connection. */
  readonly inventoryGeneration: number;
}

let observedRunId: string | undefined;
let pending: PendingRun | null = null;

function restoredSurfaces(
  surfaces: Record<string, ThreadTerminalState>,
): Record<string, ThreadTerminalState> {
  const next: Record<string, ThreadTerminalState> = {};
  for (const [id, surface] of Object.entries(surfaces))
    next[id] =
      surface.terminalIds.length === 0
        ? surface
        : normalizeThreadTerminalState({
            ...surface,
            restoredTerminalIds: [...surface.terminalIds],
          });
  return next;
}

/** Every pane restored (attach-only); pruned by `inventory` when one from the new run is known. */
export function markAllTerminalPanesRestoredInState(
  state: TerminalStateStoreState,
  inventoryFromNewRun: boolean,
): Partial<TerminalStateStoreState> {
  const next: TerminalStateStoreState = {
    ...state,
    terminalStateByThreadId: restoredSurfaces(
      state.terminalStateByThreadId,
    ) as TerminalStateStoreState["terminalStateByThreadId"],
    panelTerminalStateByThreadId: restoredSurfaces(
      state.panelTerminalStateByThreadId,
    ) as TerminalStateStoreState["panelTerminalStateByThreadId"],
  };
  const restored = [next.terminalStateByThreadId, next.panelTerminalStateByThreadId].some(
    (surfaces) => Object.values(surfaces).some((surface) => surface.terminalIds.length > 0),
  );
  if (!restored) return {};
  const inventory = inventoryFromNewRun ? readLatestTerminalInventory() : null;
  const awaiting = { ...next, restoredPanesAwaitingInventory: true };
  return inventory
    ? { ...awaiting, ...pruneRestoredPanesForInventory(awaiting, inventory) }
    : awaiting;
}

/** The connection dropped: until the next welcome, the server run is unknown. */
export function markTerminalServerRunUnknown(): void {
  if (observedRunId === undefined || pending) return;
  let release!: () => void;
  const settled = new Promise<void>((resolve) => {
    release = resolve;
  });
  pending = { settled, release, inventoryGeneration: terminalInventoryGeneration() };
}

/**
 * A welcome: the first one only records the run (a page load already restored its panes); a
 * different run marks every pane restored through `apply`.
 */
export function observeTerminalServerRun(
  runId: string | undefined,
  apply: (inventoryFromNewRun: boolean) => void,
): void {
  const settling = pending;
  pending = null;
  if (runId && observedRunId !== undefined && runId !== observedRunId)
    apply(settling !== null && terminalInventoryGeneration() > settling.inventoryGeneration);
  if (runId) observedRunId = runId;
  settling?.release();
}

/** Resolves once the current server run is known (immediately unless reconnecting). */
export function awaitTerminalServerRun(timeoutMs = TERMINAL_SERVER_RUN_WAIT_MS): Promise<void> {
  if (!pending) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    pending.settled,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function resetTerminalServerRunForTests(): void {
  pending?.release();
  pending = null;
  observedRunId = undefined;
}
