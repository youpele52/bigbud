import { watch } from "node:fs/promises";
import { Cause, Clock, Duration, Effect, FileSystem, Path, Queue, Stream } from "effect";

const DISCOVERY_WATCH_RECURSIVE = process.platform !== "linux";
const DISCOVERY_WATCH_DEBOUNCE = Duration.millis(150);
/** Pause before re-arming a watch that ended or failed, so a broken path cannot spin. */
export const DISCOVERY_WATCH_RETRY_DELAY = Duration.seconds(30);

/**
 * What to watch for one discovery descriptor. While `path` exists it is watched
 * recursively. While it is missing, `parent` (when known) is watched only for `path`
 * appearing: non-recursively, with activity elsewhere under it ignored. Watching such a
 * parent recursively turned every write under `~/.pi` or `~/.copilot` (agent session logs)
 * into a full discovery rescan.
 */
export interface DiscoveryWatchTarget {
  readonly path: string;
  /** `null` for `/etc` roots and file-system roots: never watched as a fallback. */
  readonly parent: string | null;
}

export function createDiscoveryWatchStream(
  watchPath: string,
  options: { readonly recursive?: boolean } = {},
): Stream.Stream<string, Error> {
  const recursive = options.recursive ?? DISCOVERY_WATCH_RECURSIVE;
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
            recursive,
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
  ).pipe(Stream.debounce(DISCOVERY_WATCH_DEBOUNCE));
}

const pathExists = (fs: FileSystem.FileSystem, target: string) =>
  fs.exists(target).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("DiscoveryRegistry: watch path exists check failed", {
        path: target,
        error: String(error),
      }),
    ),
    Effect.orElseSucceed(() => false),
  );

export const resolveDiscoveryWatchTarget = Effect.fn("DiscoveryRegistry.resolveWatchTarget")(
  function* (fs: FileSystem.FileSystem, path: Path.Path, rawPath: string) {
    const exists = yield* pathExists(fs, rawPath);
    // Never watch broad system roots for optional descriptors.
    if (rawPath.startsWith("/etc/")) return exists ? { path: rawPath, parent: null } : null;
    const dirname = path.dirname(rawPath);
    const parent = dirname === rawPath ? null : dirname;
    if (exists) return { path: rawPath, parent } satisfies DiscoveryWatchTarget;
    if (parent === null || !(yield* pathExists(fs, parent))) return null;
    return { path: rawPath, parent } satisfies DiscoveryWatchTarget;
  },
);

/**
 * Keeps one target watched for the life of the scope and calls `onChange` for every
 * relevant change: any change under an existing path, or a missing path appearing. Once a
 * missing path appears it is watched recursively; if it disappears again the loop falls
 * back to watching the parent. While waiting for a missing path, existence is also
 * re-checked every `retryDelay`, which covers a path created just before the parent watch
 * started and file systems that drop events.
 *
 * A live watch that ends is re-armed after `retryDelay`, and nothing is watched in between.
 * The re-arm therefore calls `onChange` once to catch up on that gap. A watch that fails
 * sooner than `retryDelay` gets no catch-up, so a path whose watch keeps failing cannot turn
 * into a rescan every `retryDelay`; the registry's periodic rescan covers it.
 */
export const runDiscoveryWatchTarget = (
  fs: FileSystem.FileSystem,
  target: DiscoveryWatchTarget,
  onChange: Effect.Effect<void>,
  retryDelay: Duration.Input = DISCOVERY_WATCH_RETRY_DELAY,
  watchStream: typeof createDiscoveryWatchStream = createDiscoveryWatchStream,
) => {
  const retryMillis = Duration.toMillis(Duration.fromInputUnsafe(retryDelay));
  let catchUp = false;
  return Effect.forever(
    Effect.gen(function* () {
      if (yield* pathExists(fs, target.path)) {
        if (catchUp) {
          catchUp = false;
          yield* onChange;
        }
        const startedAt = yield* Clock.currentTimeMillis;
        yield* Stream.runForEach(watchStream(target.path), () => onChange).pipe(
          Effect.onExit(() =>
            Effect.map(Clock.currentTimeMillis, (endedAt) => {
              catchUp = endedAt - startedAt >= retryMillis;
            }),
          ),
        );
        yield* Effect.sleep(retryDelay);
        return;
      }
      catchUp = false;
      // No parent to watch (or it was deleted too): wait quietly instead of logging an
      // ENOENT watch failure every retry.
      if (target.parent === null || !(yield* pathExists(fs, target.parent))) {
        yield* Effect.sleep(retryDelay);
        return;
      }
      yield* Stream.merge(
        watchStream(target.parent, { recursive: false }),
        Stream.tick(retryDelay),
      ).pipe(
        Stream.mapEffect(() => pathExists(fs, target.path)),
        Stream.filter((appeared) => appeared),
        Stream.take(1),
        Stream.runDrain,
      );
      // The parent watch can end without the path appearing (parent removed); never rescan
      // or spin for that.
      if (yield* pathExists(fs, target.path)) yield* onChange;
      else yield* Effect.sleep(retryDelay);
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("DiscoveryRegistry: watch stream failed", {
          watchPath: target.parent ?? target.path,
          error: String(error),
        }).pipe(Effect.andThen(Effect.sleep(retryDelay))),
      ),
    ),
  );
};
