import { RemoteBackendRelayError } from "@bigbud/contracts/server/remoteBackendRelay.ts";
interface Caller {
  readonly controller: AbortController;
  readonly pending: Set<Promise<unknown>>;
  closed: boolean;
}
const closed = () =>
  new RemoteBackendRelayError({
    code: "caller-closed",
    message: "The local client connection is closed.",
  });

/** Short-lived operation references fence a stale active-client read racing authoritative close. */
export function makeRelayCallerScopes(isActive: (caller: string) => Promise<boolean>) {
  const callers = new Map<string, Caller>();
  let disposed = false,
    pending = 0;
  const assertActive = async (caller: string) => {
    const state = callers.get(caller);
    if (
      disposed ||
      !caller ||
      state?.closed ||
      !(await isActive(caller)) ||
      state?.closed ||
      disposed
    )
      throw closed();
  };
  const closeCaller = (caller: string) => {
    const state = callers.get(caller);
    if (!state) return Promise.resolve();
    state.closed = true;
    state.controller.abort();
    return Promise.allSettled(state.pending).then(() => undefined);
  };
  return {
    assertActive,
    run<A>(
      caller: string,
      external: AbortSignal,
      operation: (signal: AbortSignal) => Promise<A>,
    ): Promise<A> {
      if (disposed || callers.get(caller)?.closed) return Promise.reject(closed());
      const state = callers.get(caller) ?? {
        controller: new AbortController(),
        pending: new Set<Promise<unknown>>(),
        closed: false,
      };
      if (pending >= 256 || state.pending.size >= 32)
        return Promise.reject(
          new RemoteBackendRelayError({
            code: "limit",
            message: "Too many pending relay operations.",
          }),
        );
      callers.set(caller, state);
      pending++;
      const signal = AbortSignal.any([external, state.controller.signal]);
      const completion = Promise.resolve()
        .then(async () => {
          await assertActive(caller);
          signal.throwIfAborted();
          return operation(signal);
        })
        .finally(() => {
          pending--;
          state.pending.delete(completion);
          if (state.pending.size === 0 && callers.get(caller) === state) callers.delete(caller);
        });
      state.pending.add(completion);
      return completion;
    },
    closeCaller,
    closeAll() {
      disposed = true;
      const closing = [...callers.keys()].map(closeCaller);
      return Promise.allSettled(closing).then(() => undefined);
    },
  };
}
