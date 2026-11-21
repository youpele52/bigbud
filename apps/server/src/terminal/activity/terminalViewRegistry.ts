import {
  TERMINAL_VIEW_LEASE_MS,
  type TerminalViewInput,
} from "@bigbud/contracts/workspace/terminal.activity.ts";

const MAX_CALLERS = 10_000;

interface TerminalView {
  readonly threadId: string | null;
  readonly terminalIds: ReadonlySet<string>;
  readonly refreshedAt: number;
}

export interface TerminalViewChange {
  /** The thread this caller newly opened (it differs from the caller's previous view). */
  readonly openedThreadId: string | null;
  readonly viewedPanes: ReadonlyArray<{ readonly threadId: string; readonly terminalId: string }>;
}

export type TerminalViewPane = { readonly threadId: string; readonly terminalId: string };

/** What each client connection is looking at. Owner of view state; never persisted. */
export class TerminalViewRegistry {
  private readonly views = new Map<string, TerminalView>();
  private readonly listeners = new Set<(panes: ReadonlyArray<TerminalViewPane>) => void>();

  /** Panes whose visibility may have changed (a report or a forgotten caller). */
  subscribe(listener: (panes: ReadonlyArray<TerminalViewPane>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** When the oldest live lease lapses (plan §14 lease expiry), or undefined with none. */
  nextExpiryAt(now = Date.now()): number | undefined {
    let next: number | undefined;
    for (const view of this.views.values()) {
      const expiresAt = view.refreshedAt + TERMINAL_VIEW_LEASE_MS;
      if (expiresAt > now && (next === undefined || expiresAt < next)) next = expiresAt;
    }
    return next;
  }

  private notify(...views: ReadonlyArray<TerminalView | undefined>): void {
    if (this.listeners.size === 0) return;
    const panes: TerminalViewPane[] = [];
    for (const view of views)
      if (view?.threadId)
        for (const terminalId of view.terminalIds)
          panes.push({ threadId: view.threadId, terminalId });
    if (panes.length === 0) return;
    for (const listener of this.listeners) listener(panes);
  }

  update(caller: string, input: TerminalViewInput, now = Date.now()): TerminalViewChange {
    const change = this.apply(caller, input, now);
    this.notify(change.previous, this.views.get(caller));
    return change.result;
  }

  private apply(
    caller: string,
    input: TerminalViewInput,
    now: number,
  ): { previous: TerminalView | undefined; result: TerminalViewChange } {
    const previous = this.views.get(caller);
    const threadId = input.threadId ?? null;
    if (threadId === null && input.terminalIds.length === 0) this.views.delete(caller);
    else if (previous || this.views.size < MAX_CALLERS)
      this.views.set(caller, {
        threadId,
        terminalIds: new Set(threadId ? input.terminalIds : []),
        refreshedAt: now,
      });
    const previousThread =
      previous && now - previous.refreshedAt < TERMINAL_VIEW_LEASE_MS ? previous.threadId : null;
    return {
      previous,
      result: {
        openedThreadId: threadId !== null && threadId !== previousThread ? threadId : null,
        viewedPanes: threadId
          ? input.terminalIds.map((terminalId) => ({ threadId, terminalId }))
          : [],
      },
    };
  }

  isViewed(threadId: string, terminalId: string, now = Date.now()): boolean {
    for (const view of this.views.values()) {
      if (now - view.refreshedAt >= TERMINAL_VIEW_LEASE_MS) continue;
      if (view.threadId === threadId && view.terminalIds.has(terminalId)) return true;
    }
    return false;
  }

  forget(caller: string): void {
    const previous = this.views.get(caller);
    this.views.delete(caller);
    this.notify(previous);
  }
}

/** Process-wide registry: connection cleanup addresses callers without a service lookup. */
export const terminalViews = new TerminalViewRegistry();
