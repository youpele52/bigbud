/** Outer deadline also settles requests whose implementations ignore cancellation. */
export function runWithAbortableDeadline<T>(input: {
  readonly operation: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", cancel);
      complete();
    };
    const fail = (error: unknown) => {
      finish(() => reject(error));
      controller.abort(error);
    };
    const cancel = () => fail(new Error(`${input.operation} cancelled.`));
    const timeout = setTimeout(() => {
      fail(new Error(`${input.operation} timed out after ${input.timeoutMs}ms.`));
    }, input.timeoutMs);
    input.signal?.addEventListener("abort", cancel, { once: true });
    if (input.signal?.aborted) cancel();
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return input.run(controller.signal);
      })
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}
