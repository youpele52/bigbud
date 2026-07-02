import { watch } from "node:fs/promises";
import { Cause, Duration, Effect, Queue, Stream } from "effect";

const DISCOVERY_WATCH_RECURSIVE = process.platform !== "linux";

export function createDiscoveryWatchStream(watchPath: string): Stream.Stream<string, Error> {
  return Stream.callback<string, Error>((queue) =>
    Effect.gen(function* () {
      const abortController = new AbortController();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          abortController.abort();
          Queue.endUnsafe(queue);
        }),
      );

      yield* Effect.promise(async () => {
        try {
          for await (const _event of watch(watchPath, {
            recursive: DISCOVERY_WATCH_RECURSIVE,
            signal: abortController.signal,
          })) {
            Queue.offerUnsafe(queue, watchPath);
          }

          Queue.endUnsafe(queue);
        } catch (cause) {
          if (abortController.signal.aborted) {
            Queue.endUnsafe(queue);
            return;
          }
          Queue.failCauseUnsafe(
            queue,
            Cause.fail(cause instanceof Error ? cause : new Error(String(cause))),
          );
        }
      });
    }),
  ).pipe(Stream.debounce(Duration.millis(150)));
}
