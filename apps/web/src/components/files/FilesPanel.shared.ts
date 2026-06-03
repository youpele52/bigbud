import type { ProjectEntry } from "@bigbud/contracts";

export interface DirectoryState {
  entries: ReadonlyArray<ProjectEntry>;
  loading: boolean;
  error: string | null;
}

export const EMPTY_ENTRIES: ReadonlyArray<ProjectEntry> = [];
export const FILES_TREE_WIDTH_STORAGE_KEY = "files_tree_width";
export const FILES_TREE_MIN_WIDTH = 220;
export const FILES_TREE_MAX_WIDTH_FACTOR = 0.6;
export const FILES_TREE_DEFAULT_WIDTH = 280;

export function entryName(entry: ProjectEntry): string {
  const segments = entry.path.split("/");
  return segments.at(-1) ?? entry.path;
}

export function makeAnnotationId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `code-annotation-${Date.now()}`;
}
