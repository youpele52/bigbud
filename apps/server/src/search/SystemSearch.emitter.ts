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
 * `maxRows` (`SYSTEM_SEARCH_MAX_ROWS` per page) across the shared tiers, and nothing is emitted
 * once the query is aborted (late batches of a superseded query are dropped). With `filesOnly`
 * (Mod+P), folders are dropped before they count against the cap.
 *
 * Tiers in `reservedRows` have their own cap instead: the project tiers answer first and can fill
 * the shared cap on their own (80 current + 120 other local), which used to leave "this computer"
 * with no rows whenever Spotlight answered after them.
 */
export class SystemSearchEmitter {
  private readonly seen = new Set<string>();
  private rows = 0;
  private readonly reservedUsed = new Map<SystemSearchTier, number>();

  constructor(
    private readonly queryId: string,
    private readonly signal: AbortSignal,
    private readonly sink: (update: SystemSearchTierUpdate) => void,
    private readonly maxRows = SYSTEM_SEARCH_MAX_ROWS,
    private readonly filesOnly = false,
    private readonly reservedRows: Partial<Record<SystemSearchTier, number>> = {},
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
    const reserved = this.reservedRows[input.tier];
    let used = reserved === undefined ? this.rows : (this.reservedUsed.get(input.tier) ?? 0);
    const cap = reserved ?? this.maxRows;
    for (const item of input.items) {
      if (this.seen.has(item.id) || (this.filesOnly && item.isDirectory)) continue;
      if (used >= cap) {
        complete = false;
        break;
      }
      this.seen.add(item.id);
      used += 1;
      items.push(item);
    }
    if (reserved === undefined) this.rows = used;
    else this.reservedUsed.set(input.tier, used);
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
