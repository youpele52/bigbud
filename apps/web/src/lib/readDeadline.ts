/** A read deadline revokes mutation authority as well as releasing its caller. */
export async function withReadDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Project and thread loading timed out. Retry loading."));
        }, timeoutMs);
      }),
    ]);
  } finally {
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  }
}
