export const FILES_PANEL_DIRECTORY_REFRESH_DEBOUNCE_MS = 100;

export function refreshVisibleDirectories(
  visibleDirectoryPaths: ReadonlyArray<string>,
  loadDirectory: (
    relativePath: string,
    options?: { readonly force?: boolean },
  ) => void | Promise<void>,
): void {
  for (const relativePath of visibleDirectoryPaths) {
    void loadDirectory(relativePath, { force: true });
  }
}

export function createDebouncedDirectoryRefresh(
  loadDirectory: (
    relativePath: string,
    options?: { readonly force?: boolean },
  ) => void | Promise<void>,
  getVisibleDirectoryPaths: () => ReadonlyArray<string>,
  debounceMs = FILES_PANEL_DIRECTORY_REFRESH_DEBOUNCE_MS,
): {
  readonly schedule: () => void;
  readonly cancel: () => void;
} {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeout(timeoutId);
    timeoutId = null;
  };

  const schedule = () => {
    cancel();
    timeoutId = setTimeout(() => {
      timeoutId = null;
      refreshVisibleDirectories(getVisibleDirectoryPaths(), loadDirectory);
    }, debounceMs);
  };

  return { schedule, cancel };
}
