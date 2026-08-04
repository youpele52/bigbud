/**
 * ServerSettings - Server-authoritative settings service.
 * Owns persistence, validation, and change notification of settings that affect
 * server-side behavior (binary paths, streaming mode, env mode, custom models,
 * text generation model selection).
 *
 * Follows the same pattern as `keybindings.ts`: JSON file + Cache + PubSub +
 * Semaphore + FileSystem.watch for concurrency and external edit detection.
 *
 * @module ServerSettings
 */
import {
  DEFAULT_SERVER_SETTINGS,
  PersistedModelSelection,
  PROVIDER_KINDS,
  ServerSettings,
  ServerSettingsError,
  type ServerSettingsPatch,
} from "@bigbud/contracts";
import {
  Cache,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Ref,
  Schema,
  Scope,
  ServiceMap,
  Stream,
  Cause,
  SchemaIssue,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "../startup/config";
import { type DeepPartial, deepMerge } from "@bigbud/shared/Struct";
import { fromLenientJson } from "@bigbud/shared/schemaJson";
import {
  decodeSettingsFieldWise,
  resolveDefaultChatCwd,
  resolveTextGenerationProvider,
  stripDefaultServerSettings,
} from "./serverSettings.persistence.ts";
export { resolveDefaultChatCwd } from "./serverSettings.persistence.ts";
import {
  preserveThreadRetentionPolicy,
  rawThreadRetentionPolicy,
  reconcileThreadRetentionPolicy,
  type ThreadRetentionSettingsOperations,
} from "./serverSettings.retention.ts";

export interface ServerSettingsShape extends ThreadRetentionSettingsOperations {
  readonly start: Effect.Effect<void, ServerSettingsError>;

  readonly ready: Effect.Effect<void, ServerSettingsError>;

  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;

  /** Patch settings and persist. Returns the new full settings object. */
  readonly updateSettings: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettings, ServerSettingsError>;

  /** Stream of settings change events. */
  readonly streamChanges: Stream.Stream<ServerSettings>;
}

export class ServerSettingsService extends ServiceMap.Service<
  ServerSettingsService,
  ServerSettingsShape
>()("t3/serverSettings/ServerSettingsService") {
  static readonly layerTest = (overrides: DeepPartial<ServerSettings> = {}) =>
    Layer.effect(
      ServerSettingsService,
      Effect.gen(function* () {
        const currentSettingsRef = yield* Ref.make<ServerSettings>(
          deepMerge(DEFAULT_SERVER_SETTINGS, overrides),
        );

        return {
          start: Effect.void,
          ready: Effect.void,
          getSettings: Ref.get(currentSettingsRef),
          updateSettings: (patch) =>
            Ref.get(currentSettingsRef).pipe(
              Effect.map((currentSettings) => deepMerge(currentSettings, patch)),
              Effect.tap((nextSettings) => Ref.set(currentSettingsRef, nextSettings)),
            ),
          setThreadRetentionPolicy: (policy) =>
            Ref.updateAndGet(currentSettingsRef, (settings) => ({
              ...settings,
              threadRetentionPolicy: policy,
            })),
          initializeThreadRetentionPolicy: (policy, _source) =>
            Ref.updateAndGet(currentSettingsRef, (settings) => ({
              ...settings,
              threadRetentionPolicy: policy,
            })),
          streamChanges: Stream.empty,
        } satisfies ServerSettingsShape;
      }),
    );
}

const ServerSettingsJson = fromLenientJson(ServerSettings);

const makeServerSettings = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
  const authorizedRetentionPolicyRef = yield* Ref.make(
    DEFAULT_SERVER_SETTINGS.threadRetentionPolicy,
  );
  const startedDeferred = yield* Deferred.make<void, ServerSettingsError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const emitChange = (settings: ServerSettings) =>
    PubSub.publish(changesPubSub, settings).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to check settings file existence",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(settingsPath).pipe(
    Effect.mapError(
      (cause) =>
        new ServerSettingsError({
          settingsPath,
          detail: "failed to read settings file",
          cause,
        }),
    ),
  );

  const loadSettingsFromDisk = Effect.gen(function* () {
    const authorizedPolicy = yield* Ref.get(authorizedRetentionPolicyRef);
    if (!(yield* readConfigExists)) {
      return reconcileThreadRetentionPolicy(DEFAULT_SERVER_SETTINGS, authorizedPolicy);
    }

    const raw = yield* readRawConfig;
    const decoded = Schema.decodeUnknownExit(ServerSettingsJson)(raw);
    if (decoded._tag === "Success") {
      return reconcileThreadRetentionPolicy(decoded.value, authorizedPolicy);
    }

    const tolerant = decodeSettingsFieldWise(raw);
    if (tolerant !== null) {
      yield* Effect.logWarning("partially recovered settings.json", {
        path: settingsPath,
        issues: Cause.pretty(decoded.cause),
      });
      return reconcileThreadRetentionPolicy(tolerant, authorizedPolicy);
    }

    yield* Effect.logWarning("failed to parse settings.json, using defaults", {
      path: settingsPath,
      issues: Cause.pretty(decoded.cause),
    });
    return reconcileThreadRetentionPolicy(DEFAULT_SERVER_SETTINGS, authorizedPolicy);
  });

  const settingsCache = yield* Cache.make<typeof cacheKey, ServerSettings, ServerSettingsError>({
    capacity: 1,
    lookup: () => loadSettingsFromDisk,
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey);

  const writeSettingsAtomically = (
    settings: ServerSettings,
    options?: { readonly preserveThreadRetentionPolicy?: boolean },
  ) => {
    const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
    const sparseSettings: Record<string, unknown> =
      (stripDefaultServerSettings(settings, DEFAULT_SERVER_SETTINGS) as Record<
        string,
        unknown
      > | null) ?? {};
    if (options?.preserveThreadRetentionPolicy) {
      preserveThreadRetentionPolicy(sparseSettings, settings);
    }

    return Effect.succeed(`${JSON.stringify(sparseSettings, null, 2)}\n`).pipe(
      Effect.tap(() => fs.makeDirectory(pathService.dirname(settingsPath), { recursive: true })),
      Effect.tap((encoded) => fs.writeFileString(tempPath, encoded)),
      Effect.flatMap(() => fs.rename(tempPath, settingsPath)),
      Effect.ensuring(fs.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true }))),
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to write settings file",
            cause,
          }),
      ),
    );
  };

  const quarantineUnauthorizedRetention = Effect.gen(function* () {
    const settings = yield* getSettingsFromCache;
    const exists = yield* readConfigExists;
    const rawPolicy = exists ? rawThreadRetentionPolicy(yield* readRawConfig) : "absent";
    const expected = settings.threadRetentionPolicy;
    if (rawPolicy === expected || (rawPolicy === "absent" && expected === "never")) return;
    yield* Effect.logWarning("quarantined unauthorized thread retention settings edit", {
      path: settingsPath,
      attemptedPolicy: rawPolicy,
      authorizedPolicy: expected,
    });
    yield* writeSettingsAtomically(settings, { preserveThreadRetentionPolicy: true });
  });

  const persistSettings = (
    settings: ServerSettings,
    options?: { readonly preserveThreadRetentionPolicy?: boolean },
  ) =>
    Effect.gen(function* () {
      yield* writeSettingsAtomically(settings, options);
      yield* Cache.set(settingsCache, cacheKey, settings);
      yield* emitChange(settings);
      return resolveTextGenerationProvider(settings);
    });

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(settingsCache, cacheKey);
      yield* quarantineUnauthorizedRetention;
      const settings = yield* getSettingsFromCache;
      yield* emitChange(settings);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const settingsDir = pathService.dirname(settingsPath);
    const settingsFile = pathService.basename(settingsPath);
    const settingsPathResolved = pathService.resolve(settingsPath);

    yield* fs.makeDirectory(settingsDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSettingsError({
            settingsPath,
            detail: "failed to prepare settings directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedSettingsEvents = fs.watch(settingsDir).pipe(
      Stream.filter((event) => {
        return (
          event.path === settingsFile ||
          event.path === settingsPath ||
          pathService.resolve(settingsDir, event.path) === settingsPathResolved
        );
      }),
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedSettingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(watcherScope),
      Effect.asVoid,
    );
  });

  const start = Effect.gen(function* () {
    const shouldStart = yield* Ref.modify(startedRef, (started) => [!started, true]);
    if (!shouldStart) {
      return yield* Deferred.await(startedDeferred);
    }

    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* Cache.invalidate(settingsCache, cacheKey);
      yield* getSettingsFromCache;
      yield* quarantineUnauthorizedRetention;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    getSettings: getSettingsFromCache.pipe(Effect.map(resolveTextGenerationProvider)),
    updateSettings: (patch) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          if (Object.prototype.hasOwnProperty.call(patch, "threadRetentionPolicy")) {
            return yield* new ServerSettingsError({
              settingsPath: "<memory>",
              detail: "threadRetentionPolicy must be changed through the dedicated retention RPC",
            });
          }
          const current = yield* getSettingsFromCache;
          const merged = deepMerge(current, patch);
          const currentSelection = current.textGenerationModelSelection as unknown;
          const preservePersistedSelection =
            patch.textGenerationModelSelection === undefined &&
            Schema.is(PersistedModelSelection)(currentSelection) &&
            !PROVIDER_KINDS.includes(currentSelection.provider as (typeof PROVIDER_KINDS)[number]);
          const candidate = preservePersistedSelection
            ? {
                ...merged,
                textGenerationModelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
              }
            : merged;
          const decoded = yield* Schema.decodeEffect(ServerSettings)(candidate).pipe(
            Effect.mapError(
              (cause) =>
                new ServerSettingsError({
                  settingsPath: "<memory>",
                  detail: `failed to normalize server settings: ${SchemaIssue.makeFormatterDefault()(cause.issue)}`,
                  cause,
                }),
            ),
          );
          const next = preservePersistedSelection
            ? ({ ...decoded, textGenerationModelSelection: currentSelection } as ServerSettings)
            : decoded;
          return yield* persistSettings(next);
        }),
      ),
    setThreadRetentionPolicy: (policy) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getSettingsFromCache;
          const updated = yield* persistSettings(
            { ...current, threadRetentionPolicy: policy },
            { preserveThreadRetentionPolicy: true },
          );
          yield* Ref.set(authorizedRetentionPolicyRef, policy);
          return updated;
        }),
      ),
    initializeThreadRetentionPolicy: (policy, _source) =>
      writeSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* getSettingsFromCache;
          const updated = yield* persistSettings(
            { ...current, threadRetentionPolicy: policy },
            { preserveThreadRetentionPolicy: true },
          );
          yield* Ref.set(authorizedRetentionPolicyRef, policy);
          return updated;
        }),
      ),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub).pipe(Stream.map(resolveTextGenerationProvider));
    },
  } satisfies ServerSettingsShape;
});

export const ServerSettingsLive = Layer.effect(ServerSettingsService, makeServerSettings);
