import { scheduleDelayedRefresh } from "~/components/files/useFilePreviewRefresh.logic";

export const DIRECTORY_CHANGE_REFRESH_DELAY_MS = 150;

function trimTrailingSeparators(pathValue: string): string {
  if (/^[A-Za-z]:[\\/]?$/.test(pathValue) || pathValue === "/") {
    return pathValue.replaceAll("\\", "/");
  }

  return pathValue.replaceAll("\\", "/").replace(/\/+$/, "");
}

export function normalizeDirectoryWatchRoots(watchRoots: ReadonlyArray<string>): string[] {
  const roots = new Set<string>();

  for (const watchRoot of watchRoots) {
    const trimmedRoot = trimTrailingSeparators(watchRoot);
    if (trimmedRoot.length > 0) {
      roots.add(trimmedRoot);
    }
  }

  return [...roots].toSorted((left, right) => left.localeCompare(right));
}

export function createDebouncedDirectoryChangeRefresh(
  refresh: () => void,
  delayMs = DIRECTORY_CHANGE_REFRESH_DELAY_MS,
): {
  readonly schedule: () => void;
  readonly cancel: () => void;
} {
  let cancelPending: (() => void) | null = null;

  const cancel = () => {
    cancelPending?.();
    cancelPending = null;
  };

  const schedule = () => {
    cancel();
    cancelPending = scheduleDelayedRefresh(refresh, delayMs);
  };

  return { schedule, cancel };
}
