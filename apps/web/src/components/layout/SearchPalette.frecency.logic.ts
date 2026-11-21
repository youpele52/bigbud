import type { SystemSearchHit } from "@bigbud/contracts/search/systemSearch.ts";

import { joinWorkspaceEntryPath } from "../files/filesPanel.dnd";
import { parseFilesPanelWorkspaceKey } from "../files/FilesPanel.workspace";
import type { FileHistory } from "../../stores/files/filesPanel.history";

/** `target\0absolutePath`: one file on one machine. */
export function openedFileKey(executionTargetId: string, absolutePath: string): string {
  return `${executionTargetId}\u0000${absolutePath}`;
}

/**
 * Files the user opened from bigbud, most recent first (0 is the latest), from the Files panel
 * histories: `historyKeys` is least-recent-first and each history's entries are oldest-first.
 */
export function openedFileRank(
  histories: Readonly<Record<string, FileHistory>>,
  historyKeys: ReadonlyArray<string>,
): ReadonlyMap<string, number> {
  const rank = new Map<string, number>();
  for (const key of historyKeys.toReversed()) {
    const workspace = parseFilesPanelWorkspaceKey(key);
    const entries = histories[key]?.entries;
    if (!workspace || !entries) continue;
    for (const entry of entries.toReversed()) {
      const file = openedFileKey(
        workspace.executionTargetId,
        joinWorkspaceEntryPath(workspace.root, entry.path),
      );
      if (!rank.has(file)) rank.set(file, rank.size);
    }
  }
  return rank;
}

/**
 * Raycast-style boost on top of the server's name ranking (exact, prefix, word prefix, fuzzy,
 * then recency): files opened from bigbud come first, most recently opened first; every other
 * row keeps its server order. Deterministic and stable.
 */
export function boostOpenedFiles(
  rows: ReadonlyArray<SystemSearchHit>,
  rank: ReadonlyMap<string, number>,
): SystemSearchHit[] {
  if (rank.size === 0) return [...rows];
  const position = (row: SystemSearchHit) =>
    rank.get(openedFileKey(row.executionTargetId, joinWorkspaceEntryPath(row.root, row.path))) ??
    Number.POSITIVE_INFINITY;
  return rows
    .map((row, index) => ({ row, index, position: position(row) }))
    .toSorted((left, right) => left.position - right.position || left.index - right.index)
    .map(({ row }) => row);
}
