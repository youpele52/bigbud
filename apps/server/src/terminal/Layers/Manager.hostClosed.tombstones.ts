/**
 * Host-closed terminals the manager no longer retains (plan §11.1, D1). The manager keeps a
 * bounded set of ended sessions and evicts the oldest; once a terminal the host closed (idle,
 * memory, limit, orphan) is evicted, a later plain open of its id would otherwise spawn a fresh
 * shell. A small bounded tombstone per thread keeps that open answering "ended" instead.
 *
 * The host reports a close after the reap, so the session may already be evicted (as a plain
 * exit) when the notice arrives: evicted host panes are remembered by PTY id for a while, so
 * the late notice still finds its pane and leaves the tombstone. Panes no session held (a host
 * pane kept across a backend restart) get one the same way.
 *
 * @module Manager.hostClosed.tombstones
 */
import {
  TERMINAL_HOST_CLOSED_REASONS,
  type TerminalEndedReason,
} from "@bigbud/contracts/workspace/terminal.limit.ts";

import { terminalHostClosedSession } from "./Manager.hostLifecycle.ts";
import type { TerminalSessionState } from "./Manager.types.ts";

export const TERMINAL_HOST_CLOSED_TOMBSTONES_PER_THREAD = 256;
export const TERMINAL_HOST_CLOSED_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
/** Evicted host panes remembered for a late close notice. */
const EVICTED_HOST_PANES = 256;

export interface TerminalPane {
  readonly threadId: string;
  readonly terminalId: string;
}

interface Tombstone {
  readonly reason: TerminalEndedReason;
  readonly at: number;
}

export class TerminalHostClosedTombstones {
  /** Per thread, terminal ids in insertion order (oldest first). */
  private readonly byThread = new Map<string, Map<string, Tombstone>>();
  /** Host PTY id to its pane, for sessions evicted before their close notice. */
  private readonly evicted = new Map<string, TerminalPane>();

  constructor(
    private readonly options: {
      readonly perThread?: number;
      readonly ttlMs?: number;
      readonly now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Called for every evicted session; host-closed ones leave a tombstone. */
  record(session: TerminalSessionState): void {
    if (terminalHostClosedSession(session) && session.endedReason) {
      this.recordClosed(session, session.endedReason);
      return;
    }
    // A later process of this pane ended some other way: its old tombstone no longer applies.
    this.byThread.get(session.threadId)?.delete(session.terminalId);
    const ptyId = session.host?.lifecycle ? session.host.ptyId : undefined;
    if (!ptyId) return;
    this.evicted.delete(ptyId);
    this.evicted.set(ptyId, { threadId: session.threadId, terminalId: session.terminalId });
    for (const id of this.evicted.keys()) {
      if (this.evicted.size <= EVICTED_HOST_PANES) break;
      this.evicted.delete(id);
    }
  }

  /** The pane of an evicted host session, for a close notice that arrived after its eviction. */
  paneForPty(ptyId: string): TerminalPane | undefined {
    return this.evicted.get(ptyId);
  }

  /** A host close of a pane no session holds; other reasons leave nothing. */
  recordClosed(pane: TerminalPane, reason: TerminalEndedReason): void {
    if (!TERMINAL_HOST_CLOSED_REASONS.includes(reason)) return;
    let thread = this.byThread.get(pane.threadId);
    if (!thread) this.byThread.set(pane.threadId, (thread = new Map()));
    thread.delete(pane.terminalId);
    thread.set(pane.terminalId, { reason, at: this.now() });
    const limit = this.options.perThread ?? TERMINAL_HOST_CLOSED_TOMBSTONES_PER_THREAD;
    for (const id of thread.keys()) {
      if (thread.size <= limit) break;
      thread.delete(id);
    }
  }

  /** Why the host closed this terminal, while its tombstone is fresh. */
  find(threadId: string, terminalId: string): TerminalEndedReason | undefined {
    const thread = this.byThread.get(threadId);
    const entry = thread?.get(terminalId);
    if (!thread || !entry) return undefined;
    if (this.now() - entry.at <= (this.options.ttlMs ?? TERMINAL_HOST_CLOSED_TOMBSTONE_TTL_MS))
      return entry.reason;
    thread.delete(terminalId);
    if (thread.size === 0) this.byThread.delete(threadId);
    return undefined;
  }
}
