/**
 * Setup runs the live terminal limit refused (plan §8.8, S3 pending-setup map). "Close oldest
 * and run setup" retries with the stored inputs; a bounded, short-lived, in-memory map is
 * enough, because a missing entry is re-derived from the thread's projection.
 *
 * @module ProjectSetupScriptRunner.pending
 */
import type { ProjectSetupScriptRunnerInput } from "../Services/ProjectSetupScriptRunner.ts";

export const PENDING_SETUP_MAX_ENTRIES = 64;
export const PENDING_SETUP_TTL_MS = 30 * 60_000;

export interface PendingProjectSetup {
  readonly input: ProjectSetupScriptRunnerInput;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly scriptId: string;
  readonly createdAt: number;
}

export class PendingProjectSetups {
  private readonly entries = new Map<string, PendingProjectSetup>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The newest refusal per thread wins; the oldest entry leaves at the bound. */
  remember(threadId: string, entry: Omit<PendingProjectSetup, "createdAt">): void {
    this.entries.delete(threadId);
    this.entries.set(threadId, { ...entry, createdAt: this.now() });
    this.prune();
    while (this.entries.size > PENDING_SETUP_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  take(threadId: string): PendingProjectSetup | undefined {
    this.prune();
    const entry = this.entries.get(threadId);
    this.entries.delete(threadId);
    return entry;
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const cutoff = this.now() - PENDING_SETUP_TTL_MS;
    for (const [threadId, entry] of this.entries)
      if (entry.createdAt < cutoff) this.entries.delete(threadId);
  }
}
