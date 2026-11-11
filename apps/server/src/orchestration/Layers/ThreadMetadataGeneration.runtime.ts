/** Bound every provider wait, including setup, even if its underlying work ignores abort. */
export function metadataAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  messages: { readonly aborted: string; readonly failed?: string },
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error(messages.aborted));
    // Observe late rejections even if cancellation wins before this handler is installed.
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(messages.failed ? new Error(messages.failed) : error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** Cleanup and its diagnostics must never replace an established execution outcome. */
export async function closeMetadataRuntime(
  close: () => Promise<void>,
  provider: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("cleanup timeout")), 1_000);
      }),
    ]);
  } catch {
    try {
      console.warn(`${provider} metadata cleanup failed.`);
    } catch {
      // A throwing diagnostic sink is not a provider failure either.
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}
