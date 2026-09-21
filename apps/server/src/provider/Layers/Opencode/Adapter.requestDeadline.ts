export function runWithAbortableDeadline<T>(input: {
  readonly operation: string;
  readonly timeoutMs: number;
  readonly run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      complete();
    };
    const timeout = setTimeout(() => {
      const error = new Error(`${input.operation} timed out after ${input.timeoutMs}ms.`);
      controller.abort(error);
      finish(() => reject(error));
    }, input.timeoutMs);
    Promise.resolve()
      .then(() => input.run(controller.signal))
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}
