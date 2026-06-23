export const FILE_PREVIEW_REFRESH_DELAY_MS = 150;

export function scheduleDelayedRefresh(
  refreshPreview: () => void,
  delayMs = FILE_PREVIEW_REFRESH_DELAY_MS,
): () => void {
  const timeoutId = setTimeout(refreshPreview, delayMs);
  return () => {
    clearTimeout(timeoutId);
  };
}

export function createDebouncedFilePreviewRefresh(
  refreshPreview: () => void,
  delayMs = FILE_PREVIEW_REFRESH_DELAY_MS,
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
    cancelPending = scheduleDelayedRefresh(refreshPreview, delayMs);
  };

  return { schedule, cancel };
}
