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

/** What each client connection is looking at. Owner of view state; never persisted. */
export class TerminalViewRegistry {
  private readonly views = new Map<string, TerminalView>();

  update(caller: string, input: TerminalViewInput, now = Date.now()): TerminalViewChange {
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
      openedThreadId: threadId !== null && threadId !== previousThread ? threadId : null,
      viewedPanes: threadId
        ? input.terminalIds.map((terminalId) => ({ threadId, terminalId }))
        : [],
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
    this.views.delete(caller);
  }
}

/** Process-wide registry: connection cleanup addresses callers without a service lookup. */
export const terminalViews = new TerminalViewRegistry();
