export const MOBILE_HOST_IDENTITY_TIMEOUT_MS = 10_000;

/** One total deadline covers response acquisition and every streaming read. */
export function createMobileIdentityRequest(parent?: AbortSignal) {
  const controller = new AbortController();
  const abortFromParent = () =>
    controller.abort(parent?.reason ?? new DOMException("Canceled", "AbortError"));
  parent?.addEventListener("abort", abortFromParent, { once: true });
  if (parent?.aborted) abortFromParent();
  const timer = setTimeout(
    () =>
      controller.abort(new Error("Backend identity verification timed out. Retry before pairing.")),
    MOBILE_HOST_IDENTITY_TIMEOUT_MS,
  );

  return {
    signal: controller.signal,
    wait<T>(work: Promise<T>): Promise<T> {
      const signal = controller.signal;
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        // Always attach both handlers, including to work that ignores AbortSignal.
        work.then(
          (value) => {
            signal.removeEventListener("abort", onAbort);
            if (signal.aborted) reject(signal.reason);
            else resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(signal.aborted ? signal.reason : error);
          },
        );
        if (signal.aborted) onAbort();
      });
    },
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
      if (!controller.signal.aborted)
        controller.abort(new DOMException("Request finished", "AbortError"));
    },
  };
}
