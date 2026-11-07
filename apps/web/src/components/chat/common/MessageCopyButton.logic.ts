/**
 * One full-text read per copy. `prefetch` starts the read early (hover or focus) so the click can
 * write the clipboard synchronously: Safari drops a clipboard write that follows a network wait.
 */
export function createFullTextPrefetch(resolveText: () => Promise<string>) {
  let entry: { readonly promise: Promise<string>; text: string | null } | null = null;

  const prefetch = (): Promise<string> => {
    if (entry) return entry.promise;
    const next: { readonly promise: Promise<string>; text: string | null } = {
      promise: resolveText(),
      text: null,
    };
    entry = next;
    next.promise.then(
      (text) => {
        next.text = text;
      },
      () => {
        // A failed read is retried on the next hover or click rather than cached.
        if (entry === next) entry = null;
      },
    );
    return next.promise;
  };

  /** The prefetched text when it already landed, else the pending read; the cache is consumed. */
  const take = (): { readonly text: string } | { readonly promise: Promise<string> } => {
    const current = entry ?? null;
    const promise = current?.promise ?? prefetch();
    entry = null;
    return current?.text != null ? { text: current.text } : { promise };
  };

  return { prefetch, take };
}
