import { randomUUID } from "node:crypto";

import { Cause, Data, Effect, FileSystem, Path } from "effect";

import { decodeEffortCacheFile, evictEffortCacheEntries } from "./effortCache.decode.ts";
import {
  EFFORT_CAPABILITY_CACHE_MAX_ENTRIES,
  EFFORT_CAPABILITY_CACHE_MAX_BYTES,
  EFFORT_CAPABILITY_CACHE_VERSION,
  type EffortCacheEntry,
  type EffortCacheFile,
} from "./effortCache.types.ts";

const stores = new Map<string, EffortCacheFile>();
const writeGenerations = new Map<string, number>();
const writeQueues = new Map<string, Promise<void>>();

class EffortCacheWriteError extends Data.TaggedError("EffortCacheWriteError")<{
  readonly cause: unknown;
}> {}

function generationKey(stateDir: string, scopeKey?: string): string {
  return `${stateDir}\u001f${scopeKey ?? ""}`;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function encodeBoundedCache(store: EffortCacheFile): string {
  const orderedEntries = Object.entries(store.entries).toSorted((left, right) =>
    right[1].verifiedAt.localeCompare(left[1].verifiedAt),
  );
  let kept = orderedEntries;
  let encoded = `${JSON.stringify({ version: store.version, entries: Object.fromEntries(kept) })}\n`;
  while (kept.length > 0 && utf8ByteLength(encoded) > EFFORT_CAPABILITY_CACHE_MAX_BYTES) {
    kept = kept.slice(0, -1);
    encoded = `${JSON.stringify({ version: store.version, entries: Object.fromEntries(kept) })}\n`;
  }
  return encoded;
}

function enqueueWrite(stateDir: string, operation: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(stateDir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  writeQueues.set(stateDir, next);
  void next.then(
    () => {
      if (writeQueues.get(stateDir) === next) writeQueues.delete(stateDir);
    },
    () => {
      if (writeQueues.get(stateDir) === next) writeQueues.delete(stateDir);
    },
  );
  return next;
}

function cacheFilePaths(path: Path.Path, stateDir: string) {
  const directory = path.join(stateDir, "effort-capabilities");
  const file = path.join(directory, `v${EFFORT_CAPABILITY_CACHE_VERSION}.json`);
  return { directory, file };
}

export const loadEffortCapabilityCache = Effect.fn("loadEffortCapabilityCache")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly stateDir: string;
}) {
  const existing = stores.get(input.stateDir);
  if (existing) return existing;
  const { file } = cacheFilePaths(input.path, input.stateDir);
  const text = yield* input.fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  const decoded = yield* Effect.try({
    try: () =>
      text.length === 0 || utf8ByteLength(text) > EFFORT_CAPABILITY_CACHE_MAX_BYTES
        ? { version: EFFORT_CAPABILITY_CACHE_VERSION, entries: {} }
        : decodeEffortCacheFile(JSON.parse(text)),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));
  const store: EffortCacheFile = decoded ?? {
    version: EFFORT_CAPABILITY_CACHE_VERSION,
    entries: {},
  };
  stores.set(input.stateDir, store);
  return store;
});

export function peekEffortCapabilityCache(stateDir: string): EffortCacheFile {
  return stores.get(stateDir) ?? { version: EFFORT_CAPABILITY_CACHE_VERSION, entries: {} };
}

export function rememberEffortCacheEntries(input: {
  readonly stateDir: string;
  readonly generation: number;
  readonly entries: ReadonlyArray<readonly [string, EffortCacheEntry]>;
  readonly scopeKey?: string;
}): EffortCacheFile {
  const current = peekEffortCapabilityCache(input.stateDir);
  const nextEntries = { ...current.entries };
  for (const [key, entry] of input.entries) {
    const previous = nextEntries[key];
    if (previous && previous.generation > entry.generation) continue;
    nextEntries[key] = entry;
  }
  const next: EffortCacheFile = {
    version: EFFORT_CAPABILITY_CACHE_VERSION,
    entries: evictEffortCacheEntries(nextEntries, EFFORT_CAPABILITY_CACHE_MAX_ENTRIES),
  };
  stores.set(input.stateDir, next);
  const key = generationKey(input.stateDir, input.scopeKey);
  writeGenerations.set(key, Math.max(writeGenerations.get(key) ?? 0, input.generation));
  return next;
}

export const persistEffortCapabilityCache = Effect.fn("persistEffortCapabilityCache")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly stateDir: string;
    readonly generation: number;
    readonly scopeKey?: string;
  }) {
    const key = generationKey(input.stateDir, input.scopeKey);
    if (writeGenerations.get(key) !== input.generation) return;
    const paths = cacheFilePaths(input.path, input.stateDir);
    const runPromise = Effect.runPromiseWith(yield* Effect.services());
    yield* Effect.tryPromise({
      try: () =>
        enqueueWrite(input.stateDir, async () => {
          if (writeGenerations.get(key) !== input.generation) return;
          const store = peekEffortCapabilityCache(input.stateDir);
          const temporaryFile = `${paths.file}.${randomUUID()}.tmp`;
          await runPromise(input.fileSystem.makeDirectory(paths.directory, { recursive: true }));
          try {
            await runPromise(
              input.fileSystem.writeFileString(temporaryFile, encodeBoundedCache(store)),
            );
            if (writeGenerations.get(key) !== input.generation) {
              await runPromise(
                input.fileSystem
                  .remove(temporaryFile, { force: true })
                  .pipe(Effect.orElseSucceed(() => undefined)),
              );
              return;
            }
            await runPromise(input.fileSystem.rename(temporaryFile, paths.file));
          } catch (cause) {
            await runPromise(
              input.fileSystem
                .remove(temporaryFile, { force: true })
                .pipe(Effect.orElseSucceed(() => undefined)),
            );
            throw cause;
          }
        }),
      catch: (cause) => new EffortCacheWriteError({ cause }),
    });
  },
);

export const saveEffortCapabilityCache = Effect.fn("saveEffortCapabilityCache")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly generation: number;
  readonly scopeKey?: string;
}) {
  yield* persistEffortCapabilityCache(input).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to persist effort capability cache", {
        cause: Cause.pretty(cause),
      }),
    ),
  );
});

export function resetEffortCapabilityCacheForTests(): void {
  stores.clear();
  writeGenerations.clear();
  writeQueues.clear();
}
