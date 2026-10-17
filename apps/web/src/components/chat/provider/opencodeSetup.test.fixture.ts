/** Controlled reply for stale-response and verification-lifecycle regressions. */
export function deferredSetupReply<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
