export const USAGE_PANEL_REFRESH_MS = 60_000;

/** Serialize requests and discard results from a closed/hidden visibility epoch. */
export function createUsagePanelPoller<T>({
  fetchSummary,
  onStart,
  onSuccess,
  onError,
}: {
  fetchSummary: (isCurrent: () => boolean) => Promise<T>;
  onStart: () => void;
  onSuccess: (summary: T) => void;
  onError: (error: unknown) => void;
}) {
  let enabled = false;
  let generation = 0;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const refresh = async () => {
    if (!enabled || inFlight) return;
    const requestGeneration = generation;
    inFlight = true;
    onStart();
    try {
      const summary = await fetchSummary(() => enabled && generation === requestGeneration);
      if (enabled && generation === requestGeneration) onSuccess(summary);
    } catch (error) {
      if (enabled && generation === requestGeneration) onError(error);
    } finally {
      inFlight = false;
      // A reopen must refresh immediately, but never overlap the previous request.
      if (enabled && generation !== requestGeneration) void refresh();
    }
  };

  return {
    setEnabled(next: boolean) {
      if (next === enabled) return;
      enabled = next;
      generation += 1;
      clearInterval(timer);
      timer = undefined;
      if (enabled) {
        timer = setInterval(() => void refresh(), USAGE_PANEL_REFRESH_MS);
        void refresh();
      }
    },
  };
}
