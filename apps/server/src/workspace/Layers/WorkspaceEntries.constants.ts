export const WORKSPACE_CACHE_TTL_MS = 15_000;
export const WORKSPACE_CACHE_MAX_KEYS = 4;
export const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
export const WORKSPACE_SCAN_READDIR_CONCURRENCY = 32;
export const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

export const processErrorDetail = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
