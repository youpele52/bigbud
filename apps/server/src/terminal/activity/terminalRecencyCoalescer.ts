import { TERMINAL_ACTIVITY_COALESCE_MS } from "@bigbud/contracts/workspace/terminal.activity.ts";

export interface TerminalRecencyWrite {
  readonly threadId: string;
  readonly terminalId: string;
  readonly atMs: number;
}

interface Entry {
  writtenAt: number;
  pending: { terminalId: string; atMs: number } | null;
}

/**
 * At most one recency write per thread per window. The first activity after a quiet window is
 * written at once; later activity inside the window is folded into one trailing write (latest
 * time wins) that becomes due when the window ends.
 */
export class TerminalRecencyCoalescer {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly windowMs = TERMINAL_ACTIVITY_COALESCE_MS) {}

  record(
    threadId: string,
    terminalId: string,
    atMs: number,
    now: number,
  ): TerminalRecencyWrite | null {
    const entry = this.entries.get(threadId);
    if (!entry || now - entry.writtenAt >= this.windowMs) {
      this.entries.set(threadId, { writtenAt: now, pending: null });
      return { threadId, terminalId, atMs };
    }
    if (!entry.pending || atMs >= entry.pending.atMs) entry.pending = { terminalId, atMs };
    return null;
  }

  /** Trailing writes whose window ended; quiet entries are forgotten after a full window. */
  takeDue(now: number): TerminalRecencyWrite[] {
    const due: TerminalRecencyWrite[] = [];
    for (const [threadId, entry] of this.entries) {
      if (now - entry.writtenAt < this.windowMs) continue;
      if (entry.pending) {
        due.push({ threadId, ...entry.pending });
        entry.pending = null;
        entry.writtenAt = now;
      } else this.entries.delete(threadId);
    }
    return due;
  }

  /** Every pending write regardless of window, for shutdown. */
  drain(): TerminalRecencyWrite[] {
    const due: TerminalRecencyWrite[] = [];
    for (const [threadId, entry] of this.entries)
      if (entry.pending) due.push({ threadId, ...entry.pending });
    this.entries.clear();
    return due;
  }
}
