/**
 * Keybindings - Keybinding configuration service definitions.
 *
 * Owns parsing, validation, merge, and persistence of user keybinding
 * configuration consumed by the server runtime.
 *
 * @module Keybindings
 */
import {
  KeybindingRule,
  KeybindingsConfigError,
  MAX_KEYBINDINGS_COUNT,
  ResolvedKeybindingsConfig,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type ServerConfigIssue,
} from "@bigbud/contracts";
import {
  Cache,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Ref,
  ServiceMap,
  Scope,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "../startup/config";
import {
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
  ResolvedKeybindingFromConfig,
} from "./keybindings.compiler";
import {
  makeLoadRuntimeCustomKeybindingsConfig,
  makeLoadWritableCustomKeybindingsConfig,
  makeReadConfigExists,
  makeReadRawConfig,
  makeWriteConfigAtomically,
} from "./keybindings.persistence";
import { makeStartWatcher, makeSyncDefaultKeybindingsOnStartup } from "./keybindings.runtime";

export {
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  ResolvedKeybindingFromConfig,
  ResolvedKeybindingsFromConfig,
} from "./keybindings.compiler";
export { parseKeybindingShortcut } from "./keybindings.parser";

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+j", command: "terminal.toggle" },
  { key: "mod+shift+j", command: "terminalPanel.toggle" },
  { key: "mod+b", command: "sidebar.toggle" },
  { key: "mod+,", command: "settings.toggle" },
  { key: "mod+f", command: "search.toggle" },
  { key: "mod+shift+g", command: "terminal.split", when: "terminalFocus" },
  { key: "mod+n", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  { key: "mod+shift+g", command: "diff.toggle", when: "!terminalFocus" },
  { key: "mod+shift+b", command: "browser.toggle", when: "!terminalFocus" },
  { key: "mod+shift+e", command: "files.toggle", when: "!terminalFocus" },
  { key: "alt+mod+b", command: "rightPanel.toggle", when: "!terminalFocus" },
  { key: "mod+p", command: "commandPalette.toggle", when: "!terminalFocus" },
  { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+o", command: "chat.new", when: "!terminalFocus" },
  { key: "mod+shift+n", command: "chat.newLocal", when: "!terminalFocus" },
  { key: "mod+o", command: "editor.openFavorite" },
  { key: "mod+shift+[", command: "thread.previous" },
  { key: "mod+shift+]", command: "thread.next" },
  ...THREAD_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    key: `mod+${index + 1}`,
    command,
  })),
];

const DEFAULT_RESOLVED_KEYBINDINGS = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);

export interface KeybindingsConfigState {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

export interface KeybindingsChangeEvent {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

/**
 * KeybindingsShape - Service API for keybinding configuration operations.
 */
export interface KeybindingsShape {
  /**
   * Start the keybindings runtime and attach file watching.
   *
   * Safe to call multiple times. The first successful call establishes the
   * runtime; later calls await the same startup.
   */
  readonly start: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Await keybindings runtime readiness.
   *
   * Readiness means the config directory exists, the watcher is attached, the
   * startup sync has completed, and the current snapshot has been loaded.
   */
  readonly ready: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Ensure the on-disk keybindings file exists and includes all default
   * commands so newly-added defaults are backfilled on startup.
   */
  readonly syncDefaultKeybindingsOnStartup: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Load runtime keybindings state along with non-fatal configuration issues.
   */
  readonly loadConfigState: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

  /**
   * Read the latest keybindings snapshot from cache/disk.
   */
  readonly getSnapshot: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

  /**
   * Stream of keybindings config change events.
   */
  readonly streamChanges: Stream.Stream<KeybindingsChangeEvent>;

  /**
   * Upsert a keybinding rule and persist the resulting configuration.
   *
   * Writes config atomically and enforces the max rule count by truncating
   * oldest entries when needed.
   */
  readonly upsertKeybindingRule: (
    rule: KeybindingRule,
  ) => Effect.Effect<ResolvedKeybindingsConfig, KeybindingsConfigError>;
}

/**
 * Keybindings - Service tag for keybinding configuration operations.
 */
export class Keybindings extends ServiceMap.Service<Keybindings, KeybindingsShape>()(
  "t3/keybindings",
) {}

const makeKeybindings = Effect.gen(function* () {
  const { keybindingsConfigPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const upsertSemaphore = yield* Semaphore.make(1);
  const resolvedConfigCacheKey = "resolved" as const;
  const changesPubSub = yield* PubSub.unbounded<KeybindingsChangeEvent>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, KeybindingsConfigError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));
  const emitChange = (configState: KeybindingsConfigState) =>
    PubSub.publish(changesPubSub, configState).pipe(Effect.asVoid);

  const readConfigExists = makeReadConfigExists(fs, keybindingsConfigPath);
  const readRawConfig = makeReadRawConfig(fs, keybindingsConfigPath);
  const loadWritableCustomKeybindingsConfig = makeLoadWritableCustomKeybindingsConfig({
    keybindingsConfigPath,
    readConfigExists,
    readRawConfig,
  });
  const loadRuntimeCustomKeybindingsConfig = makeLoadRuntimeCustomKeybindingsConfig({
    keybindingsConfigPath,
    readConfigExists,
    readRawConfig,
  });
  const writeConfigAtomically = makeWriteConfigAtomically({
    keybindingsConfigPath,
    fileSystem: fs,
    path,
  });

  const loadConfigStateFromDisk = loadRuntimeCustomKeybindingsConfig().pipe(
    Effect.map(({ keybindings, issues }) => ({
      keybindings: mergeWithDefaultKeybindings(
        DEFAULT_RESOLVED_KEYBINDINGS,
        compileResolvedKeybindingsConfig(keybindings),
      ),
      issues,
    })),
  );

  const resolvedConfigCache = yield* Cache.make<
    typeof resolvedConfigCacheKey,
    KeybindingsConfigState,
    KeybindingsConfigError
  >({
    capacity: 1,
    lookup: () => loadConfigStateFromDisk,
  });

  const loadConfigStateFromCacheOrDisk = Cache.get(resolvedConfigCache, resolvedConfigCacheKey);

  const invalidateResolvedConfigCache = Cache.invalidate(
    resolvedConfigCache,
    resolvedConfigCacheKey,
  );

  const serializeWrite = upsertSemaphore.withPermits(1);

  const revalidateAndEmit = serializeWrite(
    Effect.gen(function* () {
      yield* invalidateResolvedConfigCache;
      const configState = yield* loadConfigStateFromCacheOrDisk;
      yield* emitChange(configState);
    }),
  );

  const syncDefaultKeybindingsOnStartup = makeSyncDefaultKeybindingsOnStartup({
    serializeWrite,
    keybindingsConfigPath,
    defaultKeybindings: DEFAULT_KEYBINDINGS,
    readConfigExists,
    loadRuntimeCustomKeybindingsConfig,
    writeConfigAtomically,
    invalidateResolvedConfigCache,
  });

  const startWatcher = makeStartWatcher({
    keybindingsConfigPath,
    fileSystem: fs,
    path,
    watcherScope,
    revalidateAndEmit,
  });

  const start = Effect.gen(function* () {
    const alreadyStarted = yield* Ref.get(startedRef);
    if (alreadyStarted) {
      return yield* Deferred.await(startedDeferred);
    }

    yield* Ref.set(startedRef, true);
    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* syncDefaultKeybindingsOnStartup;
      yield* invalidateResolvedConfigCache;
      yield* loadConfigStateFromCacheOrDisk;
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
    syncDefaultKeybindingsOnStartup,
    loadConfigState: loadConfigStateFromCacheOrDisk,
    getSnapshot: loadConfigStateFromCacheOrDisk,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    upsertKeybindingRule: (rule) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const customConfig = yield* loadWritableCustomKeybindingsConfig();
          const nextConfig = [
            ...customConfig.filter((entry) => entry.command !== rule.command),
            rule,
          ];
          const cappedConfig =
            nextConfig.length > MAX_KEYBINDINGS_COUNT
              ? nextConfig.slice(-MAX_KEYBINDINGS_COUNT)
              : nextConfig;
          if (nextConfig.length > MAX_KEYBINDINGS_COUNT) {
            yield* Effect.logWarning("truncating keybindings config to max entries", {
              path: keybindingsConfigPath,
              maxEntries: MAX_KEYBINDINGS_COUNT,
            });
          }
          yield* writeConfigAtomically(cappedConfig);
          const nextResolved = mergeWithDefaultKeybindings(
            DEFAULT_RESOLVED_KEYBINDINGS,
            compileResolvedKeybindingsConfig(cappedConfig),
          );
          yield* Cache.set(resolvedConfigCache, resolvedConfigCacheKey, {
            keybindings: nextResolved,
            issues: [],
          });
          yield* emitChange({
            keybindings: nextResolved,
            issues: [],
          });
          return nextResolved;
        }),
      ),
  } satisfies KeybindingsShape;
});

export const KeybindingsLive = Layer.effect(Keybindings, makeKeybindings);
