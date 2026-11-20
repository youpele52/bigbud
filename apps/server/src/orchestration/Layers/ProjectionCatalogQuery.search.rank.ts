import type { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";

export interface RankableSearchRow {
  readonly rowId: number;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** FTS5 `bm25()`; lower is more relevant. */
  readonly rank: number;
}

export interface SearchRankContext {
  readonly currentThreadId?: ThreadId | undefined;
  readonly currentProjectId?: ProjectId | undefined;
}

/** 0 = current thread, 1 = current project, 2 = everything else. */
export function searchRowTier(row: RankableSearchRow, context: SearchRankContext): 0 | 1 | 2 {
  if (context.currentThreadId !== undefined && row.threadId === context.currentThreadId) return 0;
  if (context.currentProjectId !== undefined && row.projectId === context.currentProjectId) {
    return 1;
  }
  return 2;
}

/**
 * Reorders one newest-first keyset page by tier, then relevance, then recency. Only the rows of
 * the page move, so the rowid cursor contract (and therefore paging) is unchanged.
 */
export function rankSearchPage<Row extends RankableSearchRow>(
  rows: readonly Row[],
  context: SearchRankContext,
): Row[] {
  return rows.toSorted(
    (left, right) =>
      searchRowTier(left, context) - searchRowTier(right, context) ||
      left.rank - right.rank ||
      right.rowId - left.rowId,
  );
}

/** Keyset cursor for the next page: the oldest rowid of the page, independent of its display order. */
export function searchPageCursor(rows: readonly RankableSearchRow[]): number | undefined {
  let cursor: number | undefined;
  for (const row of rows) {
    if (cursor === undefined || row.rowId < cursor) cursor = row.rowId;
  }
  return cursor;
}
