export const FILE_HISTORY_LIMIT = 5;
export const FILE_HISTORY_WORKSPACE_LIMIT = 50;

export interface FileHistoryEntry {
  readonly path: string;
  readonly position: { readonly line: number; readonly column: number | null } | null;
  readonly scrollTop: number | null;
}

export interface FileHistory {
  readonly entries: ReadonlyArray<FileHistoryEntry>;
  readonly index: number;
}

export const EMPTY_FILE_HISTORY: FileHistory = { entries: [], index: -1 };
export const emptyFileHistory = (): FileHistory => EMPTY_FILE_HISTORY;

export function openFileInHistory(history: FileHistory, entry: FileHistoryEntry): FileHistory {
  const current = history.entries[history.index];
  if (current?.path === entry.path) {
    const entries = history.entries.slice();
    entries[history.index] = entry;
    return { entries, index: history.index };
  }

  const nextEntries = [...history.entries.slice(0, history.index + 1), entry];
  const entries = nextEntries.slice(-FILE_HISTORY_LIMIT);
  return { entries, index: entries.length - 1 };
}

export function removeFileFromHistory(history: FileHistory, path: string): FileHistory {
  const removedIndex = history.entries.findIndex((entry) => entry.path === path);
  if (removedIndex < 0) return history;

  const entries = history.entries.filter((entry) => entry.path !== path);
  if (entries.length === 0) return emptyFileHistory();

  const removedBeforeCurrent = removedIndex < history.index;
  return {
    entries,
    index: Math.min(history.index - (removedBeforeCurrent ? 1 : 0), entries.length - 1),
  };
}

export function updateCurrentFileHistoryEntry(
  history: FileHistory,
  update: Partial<Pick<FileHistoryEntry, "position" | "scrollTop">>,
): FileHistory {
  const current = history.entries[history.index];
  if (!current) return history;
  const entries = history.entries.slice();
  entries[history.index] = { ...current, ...update };
  return { entries, index: history.index };
}

export function moveFileHistory(history: FileHistory, delta: -1 | 1): FileHistory {
  const index = history.index + delta;
  if (index < 0 || index >= history.entries.length) return history;
  return { ...history, index };
}

export function canMoveFileHistory(history: FileHistory, delta: -1 | 1): boolean {
  const index = history.index + delta;
  return index >= 0 && index < history.entries.length;
}

function normalizePosition(value: unknown): FileHistoryEntry["position"] {
  if (typeof value !== "object" || value === null) return null;
  const position = value as Record<string, unknown>;
  if (
    !Number.isFinite(position.line) ||
    (position.column !== null && !Number.isFinite(position.column))
  ) {
    return null;
  }
  return {
    line: Number(position.line),
    column: position.column === null ? null : Number(position.column),
  };
}

export function normalizeFileHistory(value: unknown): FileHistory {
  if (typeof value !== "object" || value === null) return emptyFileHistory();
  const candidate = value as { entries?: unknown; index?: unknown };
  if (!Array.isArray(candidate.entries)) return emptyFileHistory();

  const entries = candidate.entries
    .flatMap((entry): FileHistoryEntry[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      if (typeof record.path !== "string" || record.path.length === 0) return [];
      return [
        {
          path: record.path,
          position: normalizePosition(record.position),
          scrollTop:
            Number.isFinite(record.scrollTop) && Number(record.scrollTop) >= 0
              ? Number(record.scrollTop)
              : null,
        },
      ];
    })
    .slice(-FILE_HISTORY_LIMIT);
  if (entries.length === 0) return emptyFileHistory();

  const index = Number.isInteger(candidate.index)
    ? Math.max(0, Math.min(Number(candidate.index), entries.length - 1))
    : entries.length - 1;
  return { entries, index };
}
