import type { TerminalEvent } from "@bigbud/contracts";
import type { TerminalLifecycleNotice } from "@bigbud/contracts/workspace/terminal.lifecycle.ts";
import type { TerminalSessionInventory } from "@bigbud/contracts/workspace/terminal.stream.ts";
import { create } from "zustand";

/** One live server terminal as the sidebar sees it (plan §8.2 "Sidebar liveness"). */
export interface TerminalLivenessEntry {
  /** Sidebar colour rule (§8.5): a program in front, or output in the last 60 s. */
  readonly busy: boolean;
  /** Set while an idle warning is pending. */
  readonly idleClosesAt: string | null;
}

/** Live terminals of one thread, keyed by terminal id. */
export type ThreadTerminalLiveness = Readonly<Record<string, TerminalLivenessEntry>>;

export interface TerminalLivenessState {
  readonly byThreadId: Readonly<Record<string, ThreadTerminalLiveness>>;
}

const QUIET_ENTRY: TerminalLivenessEntry = { busy: false, idleClosesAt: null };

/** Notice kinds after which the terminal is gone. */
export const TERMINAL_CLOSING_NOTICE_KINDS: ReadonlySet<TerminalLifecycleNotice["kind"]> = new Set<
  TerminalLifecycleNotice["kind"]
>(["idleClosed", "pressureClosed", "limitClosed", "orphanClosed", "quitClosed", "hostLost"]);

function entriesEqual(a: TerminalLivenessEntry | undefined, b: TerminalLivenessEntry): boolean {
  return a !== undefined && a.busy === b.busy && a.idleClosesAt === b.idleClosesAt;
}

function setEntry(
  state: TerminalLivenessState,
  threadId: string,
  terminalId: string,
  update: (previous: TerminalLivenessEntry | undefined) => TerminalLivenessEntry | null,
): TerminalLivenessState {
  const thread = state.byThreadId[threadId];
  const previous = thread?.[terminalId];
  const next = update(previous);
  if (next === null) {
    if (!thread || previous === undefined) return state;
    const { [terminalId]: _removed, ...rest } = thread;
    const byThreadId = { ...state.byThreadId };
    if (Object.keys(rest).length === 0) delete byThreadId[threadId];
    else byThreadId[threadId] = rest;
    return { byThreadId };
  }
  if (entriesEqual(previous, next)) return state;
  return {
    byThreadId: { ...state.byThreadId, [threadId]: { ...thread, [terminalId]: next } },
  };
}

/** Authoritative replacement; unchanged threads keep their object identity. */
export function applyLivenessInventory(
  state: TerminalLivenessState,
  inventory: TerminalSessionInventory,
): TerminalLivenessState {
  const grouped: Record<string, Record<string, TerminalLivenessEntry>> = {};
  for (const session of inventory.sessions) {
    // Exited, failed and host-lost sessions stay members, but are not running terminals.
    if (session.live === false) continue;
    const byTerminal = (grouped[session.threadId] ??= {});
    byTerminal[session.terminalId] = {
      busy: session.activity === "busy",
      idleClosesAt: session.idleClosesAt ?? null,
    };
  }
  let changed = Object.keys(state.byThreadId).length !== Object.keys(grouped).length;
  const byThreadId: Record<string, ThreadTerminalLiveness> = {};
  for (const [threadId, next] of Object.entries(grouped)) {
    const previous = state.byThreadId[threadId];
    const same =
      previous !== undefined &&
      Object.keys(previous).length === Object.keys(next).length &&
      Object.entries(next).every(([id, entry]) => entriesEqual(previous[id], entry));
    byThreadId[threadId] = same ? previous : next;
    if (!same) changed = true;
  }
  return changed ? { byThreadId } : state;
}

/** Starts add, exits remove, and `activity` reports a program in front. */
export function applyLivenessEvents(
  state: TerminalLivenessState,
  events: ReadonlyArray<TerminalEvent>,
): TerminalLivenessState {
  let next = state;
  for (const event of events) {
    if (event.type === "started" || event.type === "restarted") {
      next = setEntry(
        next,
        event.threadId,
        event.terminalId,
        (previous) => previous ?? QUIET_ENTRY,
      );
    } else if (event.type === "exited") {
      next = setEntry(next, event.threadId, event.terminalId, () => null);
    } else if (event.type === "activity") {
      next = setEntry(next, event.threadId, event.terminalId, (previous) => ({
        busy: event.hasRunningSubprocess,
        idleClosesAt: event.hasRunningSubprocess ? null : (previous?.idleClosesAt ?? null),
      }));
    }
  }
  return next;
}

/** Idle warnings set and clear the deadline; close notices remove the terminal. */
export function applyLivenessNotice(
  state: TerminalLivenessState,
  notice: TerminalLifecycleNotice,
): TerminalLivenessState {
  const { threadId, terminalId } = notice;
  if (!threadId || !terminalId) return state;
  if (notice.kind === "idleWarning" && notice.closesAt) {
    const closesAt = notice.closesAt;
    return setEntry(state, threadId, terminalId, (previous) => ({
      ...(previous ?? QUIET_ENTRY),
      idleClosesAt: closesAt,
    }));
  }
  if (notice.kind === "idleWarningCleared") {
    return setEntry(state, threadId, terminalId, (previous) =>
      previous ? { ...previous, idleClosesAt: null } : null,
    );
  }
  if (TERMINAL_CLOSING_NOTICE_KINDS.has(notice.kind)) {
    return setEntry(state, threadId, terminalId, () => null);
  }
  return state;
}

/** App-session state, never persisted: the server's inventory rebuilds it on every subscribe. */
export const useTerminalLivenessStore = create<TerminalLivenessState>(() => ({ byThreadId: {} }));

export function reconcileTerminalLivenessInventory(inventory: TerminalSessionInventory): void {
  useTerminalLivenessStore.setState((state) => applyLivenessInventory(state, inventory));
}

export function applyTerminalLivenessEvents(events: ReadonlyArray<TerminalEvent>): void {
  useTerminalLivenessStore.setState((state) => applyLivenessEvents(state, events));
}

export function applyTerminalLivenessNotice(notice: TerminalLifecycleNotice): void {
  useTerminalLivenessStore.setState((state) => applyLivenessNotice(state, notice));
}

/**
 * A confirmed close ended this terminal: drop it now rather than waiting for the next inventory,
 * so the sidebar counts never show a terminal the user just closed.
 */
export function forgetTerminalLiveness(threadId: string, terminalId: string): void {
  useTerminalLivenessStore.setState((state) => setEntry(state, threadId, terminalId, () => null));
}

const EMPTY_THREAD_LIVENESS: ThreadTerminalLiveness = Object.freeze({});

export function selectThreadTerminalLiveness(
  state: TerminalLivenessState,
  threadId: string,
): ThreadTerminalLiveness {
  return state.byThreadId[threadId] ?? EMPTY_THREAD_LIVENESS;
}
