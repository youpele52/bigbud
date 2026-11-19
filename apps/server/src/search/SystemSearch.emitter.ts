import {
  SYSTEM_SEARCH_MAX_ROWS,
  type SystemSearchHit,
  type SystemSearchReason,
  type SystemSearchSourceState,
  type SystemSearchTier,
  type SystemSearchTierUpdate,
} from "@bigbud/contracts/search/systemSearch.ts";

/**
 * Collects one query's updates: rows are deduplicated by stable ID, capped at
 * `SYSTEM_SEARCH_MAX_ROWS` across every tier, and nothing is emitted once the query is aborted
 * (late batches of a superseded query are dropped).
 */
export class SystemSearchEmitter {
  private readonly seen = new Set<string>();
  private rows = 0;

  constructor(
    private readonly queryId: string,
    private readonly signal: AbortSignal,
    private readonly sink: (update: SystemSearchTierUpdate) => void,
    private readonly maxRows = SYSTEM_SEARCH_MAX_ROWS,
  ) {}

  get aborted(): boolean {
    return this.signal.aborted;
  }

  /** Emits new rows for a source; returns false once the row cap cut some rows off. */
  rowsFor(input: {
    readonly tier: SystemSearchTier;
    readonly sourceId: string;
    readonly items: ReadonlyArray<SystemSearchHit>;
  }): boolean {
    if (this.aborted) return true;
    const items: SystemSearchHit[] = [];
    let complete = true;
    for (const item of input.items) {
      if (this.seen.has(item.id)) continue;
      if (this.rows >= this.maxRows) {
        complete = false;
        break;
      }
      this.seen.add(item.id);
      this.rows += 1;
      items.push(item);
    }
    if (items.length > 0) {
      this.sink({
        queryId: this.queryId,
        tier: input.tier,
        sourceId: input.sourceId,
        items,
        state: "partial",
        truncated: !complete,
      });
    }
    return complete;
  }

  state(input: {
    readonly tier: SystemSearchTier;
    readonly sourceId: string;
    readonly state: SystemSearchSourceState;
    readonly reason?: SystemSearchReason | undefined;
    readonly truncated?: boolean;
  }): void {
    if (this.aborted) return;
    this.sink({
      queryId: this.queryId,
      tier: input.tier,
      sourceId: input.sourceId,
      items: [],
      state: input.state,
      ...(input.reason ? { reason: input.reason } : {}),
      truncated: input.truncated ?? false,
    });
  }
}
