type WireError = new (fields: { message: string; cause: unknown }) => Error;

/** Map a picker failure onto the RPC's tagged error without changing its message. */
export async function wire<A>(ErrorType: WireError, run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (cause) {
    throw new ErrorType({
      message:
        cause instanceof Error ? cause.message : "The development SSH picker operation failed.",
      cause,
    });
  }
}

/** Race owner startup with one caller's abort, without cancelling the shared startup. */
export async function waitForOwner<A>(pending: Promise<A>, signal: AbortSignal): Promise<A> {
  signal.throwIfAborted();
  const { promise, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([pending, promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
