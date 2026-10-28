import type {
  ComputerUseActivitySnapshot,
  ComputerUseActivityTurn,
} from "@bigbud/contracts/server/computerUseActivity.ts";
import type { ThreadId, TurnId } from "@bigbud/contracts";

import type {
  ComputerUseActivityAction,
  ComputerUseActivityEntry,
  ComputerUseActivityKey,
} from "./Services/ComputerUseActivity.ts";

/**
 * How long a finished action keeps counting after its turn stopped running. A tool call returns
 * within seconds even for long `type` actions, while the driver may still be delivering input,
 * and a single action can carry up to 10k characters. Showing Stop slightly too long only costs
 * a driver reset; hiding it while input is still arriving would leave the user without a Stop.
 */
export const COMPUTER_USE_ACTIVITY_LINGER_MS = 60_000;
const MAX_ENTRIES = 256;
const MAX_STOPPED_KEYS = 1_024;

export interface ComputerUseActivityState {
  readonly entries: ReadonlyMap<string, ComputerUseActivityEntry>;
  readonly stoppedKeys: ReadonlySet<string>;
  /** Increases at every Stop; an admission is current while the epoch it saw is unchanged. */
  readonly stopEpoch: number;
}

export const emptyComputerUseActivityState: ComputerUseActivityState = {
  entries: new Map(),
  stoppedKeys: new Set(),
  stopEpoch: 0,
};

export const computerUseActivityKey = (key: ComputerUseActivityKey): string =>
  JSON.stringify([key.threadId, key.turnId]);

/** Only a known turn can be stopped; a turn-less action cannot be told apart from later ones. */
const isStoppedKey = (state: ComputerUseActivityState, key: ComputerUseActivityKey) =>
  key.turnId !== null && state.stoppedKeys.has(computerUseActivityKey(key));

function boundEntries(entries: Map<string, ComputerUseActivityEntry>): void {
  for (const [id, entry] of entries) {
    if (entries.size <= MAX_ENTRIES) return;
    if (entry.actionsInFlight === 0) entries.delete(id);
  }
}

/** Returns whether the action may run, with the next state. */
export function beginComputerUseAction(
  state: ComputerUseActivityState,
  action: ComputerUseActivityAction,
  nowMs: number,
): readonly [boolean, ComputerUseActivityState] {
  if (isStoppedKey(state, action)) return [false, state];
  const id = computerUseActivityKey(action);
  const current = state.entries.get(id);
  const entries = new Map(state.entries);
  entries.delete(id);
  entries.set(id, {
    threadId: action.threadId,
    turnId: action.turnId,
    actionsInFlight: (current?.actionsInFlight ?? 0) + 1,
    usedDesktop: (current?.usedDesktop ?? false) || action.surface === "desktop",
    lastActivityAtMs: nowMs,
    lastEndedAtMs: current?.lastEndedAtMs ?? null,
    stopped: false,
  });
  boundEntries(entries);
  return [true, { ...state, entries }];
}

export function endComputerUseAction(
  state: ComputerUseActivityState,
  key: ComputerUseActivityKey,
  nowMs: number,
): ComputerUseActivityState {
  const id = computerUseActivityKey(key);
  const current = state.entries.get(id);
  if (!current) return state;
  const entries = new Map(state.entries).set(id, {
    ...current,
    actionsInFlight: Math.max(0, current.actionsInFlight - 1),
    lastActivityAtMs: nowMs,
    lastEndedAtMs: nowMs,
  });
  return { ...state, entries };
}

export function markComputerUseStopped(
  state: ComputerUseActivityState,
  keys: ReadonlyArray<ComputerUseActivityKey>,
): ComputerUseActivityState {
  const entries = new Map(state.entries);
  const stoppedKeys = new Set(state.stoppedKeys);
  for (const key of keys) {
    const id = computerUseActivityKey(key);
    const current = entries.get(id);
    if (current) entries.set(id, { ...current, stopped: true });
    if (key.turnId !== null) {
      stoppedKeys.delete(id);
      stoppedKeys.add(id);
    }
  }
  for (const id of stoppedKeys) {
    if (stoppedKeys.size <= MAX_STOPPED_KEYS) break;
    stoppedKeys.delete(id);
  }
  return { entries, stoppedKeys, stopEpoch: state.stopEpoch + 1 };
}

export function pruneComputerUseActivity(
  state: ComputerUseActivityState,
  keep: (entry: ComputerUseActivityEntry) => boolean,
): ComputerUseActivityState {
  let entries: Map<string, ComputerUseActivityEntry> | null = null;
  for (const [id, entry] of state.entries) {
    if (entry.actionsInFlight > 0 || keep(entry)) continue;
    entries ??= new Map(state.entries);
    entries.delete(id);
  }
  return entries ? { ...state, entries } : state;
}

export interface ComputerUseThreadSessionView {
  readonly id: ThreadId;
  readonly session: { readonly activeTurnId: TurnId | null } | null;
}

/**
 * A turn uses computer use while one of its actions is in flight, while the session still runs
 * that turn, or within the linger window after its last action. A stopped turn counts only while
 * an action is still in flight.
 */
export function deriveComputerUseActivity(
  entries: ReadonlyArray<ComputerUseActivityEntry>,
  threads: ReadonlyArray<ComputerUseThreadSessionView>,
  nowMs: number,
): ComputerUseActivitySnapshot {
  if (entries.length === 0) return { active: false, turns: [] };
  const trackedThreadIds = new Set(entries.map((entry) => entry.threadId));
  const activeTurnIds = new Map<ThreadId, TurnId | null>();
  for (const thread of threads) {
    if (trackedThreadIds.has(thread.id)) {
      activeTurnIds.set(thread.id, thread.session?.activeTurnId ?? null);
    }
  }
  const turns: ComputerUseActivityTurn[] = [];
  for (const entry of entries) {
    const actionInFlight = entry.actionsInFlight > 0;
    const turnRunning = entry.turnId !== null && activeTurnIds.get(entry.threadId) === entry.turnId;
    const lingering =
      entry.lastEndedAtMs !== null && nowMs - entry.lastEndedAtMs < COMPUTER_USE_ACTIVITY_LINGER_MS;
    if (actionInFlight || (!entry.stopped && (turnRunning || lingering))) {
      turns.push({
        threadId: entry.threadId,
        turnId: entry.turnId,
        actionInFlight,
        turnRunning,
        usedDesktop: entry.usedDesktop,
      });
    }
  }
  turns.sort((left, right) =>
    left.threadId === right.threadId
      ? String(left.turnId).localeCompare(String(right.turnId))
      : left.threadId.localeCompare(right.threadId),
  );
  return { active: turns.length > 0, turns };
}

export function sameComputerUseActivity(
  left: ComputerUseActivitySnapshot,
  right: ComputerUseActivitySnapshot,
): boolean {
  return (
    left.active === right.active &&
    left.turns.length === right.turns.length &&
    left.turns.every((turn, index) => {
      const other = right.turns[index]!;
      return (
        turn.threadId === other.threadId &&
        turn.turnId === other.turnId &&
        turn.actionInFlight === other.actionInFlight &&
        turn.turnRunning === other.turnRunning &&
        turn.usedDesktop === other.usedDesktop
      );
    })
  );
}

/** Idle entries worth keeping: their turn may still run, or they may still linger. */
export function isComputerUseEntryRelevant(
  entry: ComputerUseActivityEntry,
  threads: ReadonlyArray<ComputerUseThreadSessionView>,
  nowMs: number,
): boolean {
  return deriveComputerUseActivity([{ ...entry, stopped: false }], threads, nowMs).active;
}
