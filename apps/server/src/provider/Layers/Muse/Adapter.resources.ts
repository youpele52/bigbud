import { Effect } from "effect";

import { mapMuseRequestError } from "./Client.errors.ts";

/** Cleanup is total: synchronous throws and rejected promises cannot skip other resources. */
export async function closeMuseResources(
  cleanups: ReadonlyArray<() => Promise<void>>,
): Promise<void> {
  await Promise.allSettled(cleanups.map((cleanup) => Promise.resolve().then(cleanup)));
}

/** Own acquisitions before Effect resumes, including factories resolving after interruption. */
export function makeMuseStartupOwner() {
  const cleanups: Array<() => Promise<void>> = [];
  let closed = false;
  const abort = new AbortController();
  return {
    signal: abort.signal,
    acquire<T>(method: string, acquire: () => Promise<T>, release: (value: T) => Promise<void>) {
      return Effect.tryPromise({
        try: async () => {
          const value = await acquire();
          if (closed) {
            await closeMuseResources([() => release(value)]);
            throw new Error("Muse startup acquisition completed after cancellation.");
          }
          cleanups.push(() => release(value));
          return value;
        },
        catch: (cause) => mapMuseRequestError(method, cause, "provider-unavailable"),
      });
    },
    async cleanup() {
      if (closed) return;
      closed = true;
      abort.abort();
      await closeMuseResources(cleanups.splice(0).toReversed());
    },
  };
}
