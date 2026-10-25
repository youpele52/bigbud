/** Contexts painting visible terminals. */
export const VISIBLE_WEBGL_CONTEXTS = 8;
/**
 * Hidden terminals keep their WebGL context (Orca keeps 6 LRU) so tab and split switches skip the
 * atlas rebuild. 8 + 6 = 14 stays under Chromium's 16 live contexts per renderer process.
 */
export const RETAINED_HIDDEN_WEBGL_CONTEXTS = 6;

interface RetainedContext {
  readonly evict: () => void;
}

export class TerminalRendererBudget {
  private contexts = 0;
  private retained: RetainedContext[] = [];
  private incidents: number[] = [];
  private latched = false;

  reserve(): (() => void) | null {
    if (this.contexts >= VISIBLE_WEBGL_CONTEXTS) return null;
    this.contexts++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.contexts--;
      }
    };
  }

  /**
   * Park a hidden view's context; the least recently hidden one beyond the cap is evicted (its
   * view falls back to DOM). The returned release removes the entry without evicting it.
   */
  retain(evict: () => void): () => void {
    const entry: RetainedContext = { evict };
    this.retained.push(entry);
    while (this.retained.length > RETAINED_HIDDEN_WEBGL_CONTEXTS) {
      const oldest = this.retained.shift()!;
      try {
        oldest.evict();
      } catch {
        /* Eviction only disposes renderer resources; the emulator stays intact. */
      }
    }
    return () => {
      const index = this.retained.indexOf(entry);
      if (index !== -1) this.retained.splice(index, 1);
    };
  }

  loss(now: number): void {
    this.incidents = this.incidents.filter((time) => now - time < 60_000);
    if (this.incidents.length === 0 || now - this.incidents.at(-1)! >= 1000)
      this.incidents.push(now);
    if (this.incidents.length >= 3) this.latched = true;
  }
  get isLatched(): boolean {
    return this.latched;
  }
  /** Visible contexts. */
  get count(): number {
    return this.contexts;
  }
  get retainedCount(): number {
    return this.retained.length;
  }
}
export const terminalRendererBudget = new TerminalRendererBudget();
