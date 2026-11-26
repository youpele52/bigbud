export const SUBSCRIPTION_REFRESH_INTERVAL_MS = 5 * 60_000;

/** One timer and one in-flight request for all visible Usage surfaces. */
export function createSubscriptionRefreshCoordinator<A>(read: () => Promise<A>) {
  let viewers = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextDue = 0;
  let pending: Promise<A> | undefined;

  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (!viewers || pending) return;
    const delay = nextDue - Date.now();
    if (delay <= 0) {
      void refresh().catch(() => undefined);
    } else {
      timer = setTimeout(schedule, delay);
    }
  }

  function refresh() {
    if (pending) return pending;
    nextDue = Date.now() + SUBSCRIPTION_REFRESH_INTERVAL_MS;
    clearTimeout(timer);
    timer = undefined;
    pending = Promise.resolve()
      .then(read)
      .finally(() => {
        pending = undefined;
        schedule();
      });
    return pending;
  }

  return {
    refresh,
    watch() {
      viewers++;
      schedule();
      return () => {
        viewers--;
        schedule();
      };
    },
  };
}
