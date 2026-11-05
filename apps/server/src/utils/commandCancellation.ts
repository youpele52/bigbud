/** A cancellation request is not proof that the remote process terminated. */
export class CommandCancellationUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super(
      "Remote command cancellation could not be confirmed. Existing work may still be running; no new commands are allowed.",
      { cause },
    );
    this.name = "CommandCancellationUnconfirmedError";
  }
}

export class CommandCancelledError extends Error {
  constructor() {
    super("Remote command was cancelled.");
    this.name = "CommandCancelledError";
  }
}

/** Dispatch first, then cancel the exact operation. Never leave a rejected cancellation unobserved. */
export async function withCommandCancellation<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
  cancel: () => Promise<unknown>,
): Promise<T> {
  if (!signal) return run();
  if (signal.aborted) throw new CommandCancelledError();
  const result = run();
  // Observe the operation even if cancellation fails before its result becomes available.
  void result.catch(() => {});
  let cancellation: Promise<never> | undefined;
  let wake!: (value: Promise<never>) => void;
  const cancelled = new Promise<never>((resolve) => {
    wake = resolve;
  });
  const abort = () => {
    cancellation ??= Promise.resolve()
      .then(cancel)
      .then(
        () => {
          throw new CommandCancelledError();
        },
        (cause: unknown) => {
          throw new CommandCancellationUnconfirmedError(cause);
        },
      );
    wake(cancellation);
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    return await Promise.race([result, cancelled]);
  } finally {
    signal?.removeEventListener("abort", abort);
    // A normal/failed result racing Stop must still join the physical cancellation.
    if (cancellation) await cancellation;
  }
}
