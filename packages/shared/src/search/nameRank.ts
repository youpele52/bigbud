/**
 * Fuzzy file-name ranking (VS Code quick-open style) shared by Mod+P's in-memory project list
 * (`WorkspaceEntries`) and, through `nameRank.fixtures.json`, the Rust agent's
 * `search/rank.rs`. Both must rank the same entries identically, so local and remote results
 * match: lower scores are better, ties break by path in code point order (Rust's byte order).
 *
 * Positions are UTF-16 code units, like JavaScript string indices; the Rust side counts the same
 * units, including for paths with non-BMP characters.
 */
export interface NameRankCandidate {
  readonly path: string;
  readonly kind: "file" | "directory";
  /** `path` lowercased. */
  readonly normalizedPath: string;
  /** The last `/` segment of `normalizedPath`. */
  readonly normalizedName: string;
}

export interface RankedName<Candidate extends NameRankCandidate> {
  entry: Candidate;
  score: number;
}

/** Lowercased path and basename, the fields `scoreNameRankCandidate` compares against. */
export function nameRankFields(path: string): {
  readonly normalizedPath: string;
  readonly normalizedName: string;
} {
  const normalizedPath = path.toLowerCase();
  const separatorIndex = normalizedPath.lastIndexOf("/");
  return {
    normalizedPath,
    normalizedName:
      separatorIndex === -1 ? normalizedPath : normalizedPath.slice(separatorIndex + 1),
  };
}

/** Trims, drops leading `@`, `.` and `/`, and lowercases (rank.rs `normalize_query`). */
export function normalizeNameRankQuery(input: string): string {
  return input
    .trim()
    .replace(/^[@./]+/, "")
    .toLowerCase();
}

export function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      continue;
    }

    if (firstMatchIndex === -1) {
      firstMatchIndex = valueIndex;
    }
    if (previousMatchIndex !== -1) {
      gapPenalty += valueIndex - previousMatchIndex - 1;
    }

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const spanPenalty = valueIndex - firstMatchIndex + 1 - query.length;
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 3 + spanPenalty + lengthPenalty;
    }
  }

  return null;
}

/** Score for an already normalized query, or `null` when the entry does not match. */
export function scoreNameRankCandidate(entry: NameRankCandidate, query: string): number | null {
  if (!query) {
    return entry.kind === "directory" ? 0 : 1;
  }

  const { normalizedPath, normalizedName } = entry;

  if (normalizedName === query) return 0;
  if (normalizedPath === query) return 1;
  if (normalizedName.startsWith(query)) return 2;
  if (normalizedPath.startsWith(query)) return 3;
  if (normalizedPath.includes(`/${query}`)) return 4;
  if (normalizedName.includes(query)) return 5;
  if (normalizedPath.includes(query)) return 6;

  const nameFuzzyScore = scoreSubsequenceMatch(normalizedName, query);
  if (nameFuzzyScore !== null) {
    return 100 + nameFuzzyScore;
  }

  const pathFuzzyScore = scoreSubsequenceMatch(normalizedPath, query);
  if (pathFuzzyScore !== null) {
    return 200 + pathFuzzyScore;
  }

  return null;
}

/** Code point order, which is Rust's `String` (UTF-8 byte) order; not locale order. */
export function compareCodePointOrder(left: string, right: string): number {
  const leftPoints = left[Symbol.iterator]();
  const rightPoints = right[Symbol.iterator]();
  for (;;) {
    const leftNext = leftPoints.next();
    const rightNext = rightPoints.next();
    if (leftNext.done || rightNext.done) {
      return Number(!leftNext.done) - Number(!rightNext.done);
    }
    const delta = leftNext.value.codePointAt(0)! - rightNext.value.codePointAt(0)!;
    if (delta !== 0) return delta;
  }
}

export function compareRankedNames<Candidate extends NameRankCandidate>(
  left: RankedName<Candidate>,
  right: RankedName<Candidate>,
): number {
  return left.score - right.score || compareCodePointOrder(left.entry.path, right.entry.path);
}

function insertionIndex<Candidate extends NameRankCandidate>(
  rankedEntries: RankedName<Candidate>[],
  candidate: RankedName<Candidate>,
): number {
  let low = 0;
  let high = rankedEntries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const current = rankedEntries[middle];
    if (!current) break;
    if (compareRankedNames(candidate, current) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}

/** Keeps the best `limit` candidates, best first (rank.rs `RankedEntries::insert`). */
export function insertRankedName<Candidate extends NameRankCandidate>(
  rankedEntries: RankedName<Candidate>[],
  candidate: RankedName<Candidate>,
  limit: number,
): void {
  if (limit <= 0) return;
  const index = insertionIndex(rankedEntries, candidate);
  if (rankedEntries.length < limit) {
    rankedEntries.splice(index, 0, candidate);
    return;
  }
  if (index >= limit) return;
  rankedEntries.splice(index, 0, candidate);
  rankedEntries.pop();
}
