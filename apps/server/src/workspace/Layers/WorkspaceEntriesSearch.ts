/**
 * Pure path helpers for workspace entry search. Ranking lives in `@bigbud/shared/search/nameRank`,
 * shared with the Rust engine through common fixtures so local and remote results rank alike.
 */
import {
  insertRankedName,
  nameRankFields,
  normalizeNameRankQuery,
  scoreNameRankCandidate,
  type NameRankCandidate,
  type RankedName,
} from "@bigbud/shared/search/nameRank";

export interface SearchableWorkspaceEntry extends NameRankCandidate {
  readonly parentPath?: string | undefined;
}

export function rankWorkspaceIndex(
  index: { readonly entries: readonly SearchableWorkspaceEntry[]; readonly truncated: boolean },
  input: { readonly query: string; readonly limit: number },
) {
  const query = normalizeNameRankQuery(input.query);
  const limit = Math.max(0, Math.floor(input.limit));
  const ranked: RankedName<SearchableWorkspaceEntry>[] = [];
  let matched = 0;
  for (const entry of index.entries) {
    const score = scoreNameRankCandidate(entry, query);
    if (score === null) continue;
    matched++;
    insertRankedName(ranked, { entry, score }, limit);
  }
  return {
    entries: ranked.map(({ entry }) => entry),
    truncated: index.truncated || matched > limit,
  };
}

// ── Path helpers ─────────────────────────────────────────────────────

export function toPosixPath(input: string): string {
  return input.replaceAll("\\", "/");
}

export function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  if (separatorIndex === -1) {
    return undefined;
  }
  return input.slice(0, separatorIndex);
}

export function toSearchableWorkspaceEntry(entry: {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly parentPath?: string | undefined;
}): SearchableWorkspaceEntry {
  return { ...entry, ...nameRankFields(entry.path) };
}

export function isPathInIgnoredDirectory(
  relativePath: string,
  ignoredDirectoryNames: Set<string>,
): boolean {
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment) return false;
  return ignoredDirectoryNames.has(firstSegment);
}

export function directoryAncestorsOf(relativePath: string): string[] {
  const segments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) return [];

  const directories: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    directories.push(segments.slice(0, index).join("/"));
  }
  return directories;
}
