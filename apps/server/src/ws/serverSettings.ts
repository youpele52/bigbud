/**
 * ServerSettings - Server-authoritative settings service.
 *
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
import { resolveProviderWorkload } from "../provider/providerWorkloadSupport.ts";
import {
  decodeSettingsFieldWise,
  stripDefaultServerSettings,
} from "./serverSettings.persistence.ts";

export interface ServerSettingsShape {
  /** Start the settings runtime and attach file watching. */
  readonly start: Effect.Effect<void, ServerSettingsError>;

  /** Await settings runtime readiness. */
  readonly ready: Effect.Effect<void, ServerSettingsError>;

  /** Read the current settings. */
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
          streamChanges: Stream.empty,
        } satisfies ServerSettingsShape;
      }),
    );
}

const ServerSettingsJson = fromLenientJson(ServerSettings);

function resolveTextGenerationProvider(settings: ServerSettings): ServerSettings {
  const selection = settings.textGenerationModelSelection;
  if (!PROVIDER_KINDS.includes(selection.provider as (typeof PROVIDER_KINDS)[number])) {
    return settings;
  }
  const providerSettings =
    settings.providers[selection.provider as keyof ServerSettings["providers"]];
  if (providerSettings?.enabled) return settings;
  const resolution = resolveProviderWorkload({
    requested: selection,
    workload: "unattendedTextGeneration",
    availableProviderKinds: PROVIDER_KINDS.filter(
      (provider) => settings.providers[provider].enabled,
    ),
  });
  if (!resolution.actual || resolution.actual.provider === selection.provider) {
    return settings;
  }
  return {
    ...settings,
    textGenerationModelSelection: resolution.actual,
  };
}

function expandTildePath(input: string): string {
  if (input === "~") {
    return `${process.env.HOME ?? process.cwd()}`;
  }
  if (input.startsWith("~/")) {
    return `${process.env.HOME ?? process.cwd()}/${input.slice(2)}`;
  }
  return input;
}

export function resolveDefaultChatCwd(settings: ServerSettings): string {
  const candidate = settings.defaultChatCwd.trim();
  return expandTildePath(candidate.length > 0 ? candidate : DEFAULT_SERVER_SETTINGS.defaultChatCwd);
}

const makeServerSettings = Effect.gen(function* () {
  const { settingsPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const writeSemaphore = yield* Semaphore.make(1);
  const cacheKey = "settings" as const;
  const changesPubSub = yield* PubSub.unbounded<ServerSettings>();
  const startedRef = yield* Ref.make(false);
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
    if (!(yield* readConfigExists)) {
      return DEFAULT_SERVER_SETTINGS;
    }

    const raw = yield* readRawConfig;
    const decoded = Schema.decodeUnknownExit(ServerSettingsJson)(raw);
    if (decoded._tag === "Success") return decoded.value;

    const tolerant = decodeSettingsFieldWise(raw);
    if (tolerant !== null) {
      yield* Effect.logWarning("partially recovered settings.json", {
        path: settingsPath,
        issues: Cause.pretty(decoded.cause),
      });
      return tolerant;
    }

    yield* Effect.logWarning("failed to parse settings.json, using defaults", {
      path: settingsPath,
      issues: Cause.pretty(decoded.cause),
    });
    return DEFAULT_SERVER_SETTINGS;
  });

  const settingsCache = yield* Cache.make<typeof cacheKey, ServerSettings, ServerSettingsError>({
    capacity: 1,
    lookup: () => loadSettingsFromDisk,
  });

  const getSettingsFromCache = Cache.get(settingsCache, cacheKey);

  const writeSettingsAtomically = (settings: ServerSettings) => {
    const tempPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`;
    const sparseSettings = stripDefaultServerSettings(settings, DEFAULT_SERVER_SETTINGS) ?? {};

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

  const persistSettings = (settings: ServerSettings) =>
    Effect.gen(function* () {
      yield* writeSettingsAtomically(settings);
      yield* Cache.set(settingsCache, cacheKey, settings);
      yield* emitChange(settings);
      return resolveTextGenerationProvider(settings);
    });

  const revalidateAndEmit = writeSemaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* Cache.invalidate(settingsCache, cacheKey);
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
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub).pipe(Stream.map(resolveTextGenerationProvider));
    },
  } satisfies ServerSettingsShape;
});

export const ServerSettingsLive = Layer.effect(ServerSettingsService, makeServerSettings);
