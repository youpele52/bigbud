/**
 * Keybindings runtime helpers.
 *
 * Extracted from keybindings.ts to keep the main service file focused on
 * service wiring and state management.
 *
 * @module KeybindingsRuntime
 */
import {
  KeybindingRule,
  KeybindingsConfigError,
  MAX_KEYBINDINGS_COUNT,
  type ServerConfigIssue,
} from "@bigbud/contracts";
import { Duration, Effect, FileSystem, Path, Scope, Stream } from "effect";

import { hasSameShortcutContext, isSameKeybindingRule } from "./keybindings.compiler";

type SerializeWrite = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

interface RuntimeCustomKeybindingsConfig {
  readonly keybindings: readonly KeybindingRule[];
  readonly issues: readonly ServerConfigIssue[];
}

export function makeSyncDefaultKeybindingsOnStartup(input: {
  readonly serializeWrite: SerializeWrite;
  readonly keybindingsConfigPath: string;
  readonly defaultKeybindings: ReadonlyArray<KeybindingRule>;
  readonly readConfigExists: Effect.Effect<boolean, KeybindingsConfigError>;
  readonly loadRuntimeCustomKeybindingsConfig: () => Effect.Effect<
    RuntimeCustomKeybindingsConfig,
    KeybindingsConfigError
  >;
  readonly writeConfigAtomically: (
    rules: readonly KeybindingRule[],
  ) => Effect.Effect<void, KeybindingsConfigError>;
  readonly invalidateResolvedConfigCache: Effect.Effect<void, KeybindingsConfigError>;
}) {
  return input.serializeWrite(
    Effect.gen(function* () {
      const configExists = yield* input.readConfigExists;
      if (!configExists) {
        yield* input.writeConfigAtomically(input.defaultKeybindings);
        yield* input.invalidateResolvedConfigCache;
        return;
      }

      const runtimeConfig = yield* input.loadRuntimeCustomKeybindingsConfig();
      if (runtimeConfig.issues.length > 0) {
        yield* Effect.logWarning(
          "skipping startup keybindings default sync because config has issues",
          {
            path: input.keybindingsConfigPath,
            issues: runtimeConfig.issues,
          },
        );
        yield* input.invalidateResolvedConfigCache;
        return;
      }

      const customConfig = runtimeConfig.keybindings;
      const existingCommands = new Set(customConfig.map((entry) => entry.command));
      const missingDefaults: KeybindingRule[] = [];
      const shortcutConflictWarnings: Array<{
        defaultCommand: KeybindingRule["command"];
        conflictingCommand: KeybindingRule["command"];
        key: string;
        when: string | null;
      }> = [];

      for (const defaultRule of input.defaultKeybindings) {
        if (existingCommands.has(defaultRule.command)) {
          continue;
        }
        const conflictingEntry = customConfig.find((entry) =>
          hasSameShortcutContext(entry, defaultRule),
        );
        if (conflictingEntry) {
          shortcutConflictWarnings.push({
            defaultCommand: defaultRule.command,
            conflictingCommand: conflictingEntry.command,
            key: defaultRule.key,
            when: defaultRule.when ?? null,
          });
          continue;
        }
        missingDefaults.push(defaultRule);
      }

      for (const conflict of shortcutConflictWarnings) {
        yield* Effect.logWarning("skipping default keybinding due to shortcut conflict", {
          path: input.keybindingsConfigPath,
          defaultCommand: conflict.defaultCommand,
          conflictingCommand: conflict.conflictingCommand,
          key: conflict.key,
          when: conflict.when,
          reason: "shortcut context already used by existing rule",
        });
      }

      if (missingDefaults.length === 0) {
        yield* input.invalidateResolvedConfigCache;
        return;
      }

      const matchingDefaults = input.defaultKeybindings
        .filter((defaultRule) =>
          customConfig.some((entry) => isSameKeybindingRule(entry, defaultRule)),
        )
        .map((rule) => rule.command);
      if (matchingDefaults.length > 0) {
        yield* Effect.logWarning("default keybinding rule already defined in user config", {
          path: input.keybindingsConfigPath,
          commands: matchingDefaults,
        });
      }

      const nextConfig = [...customConfig, ...missingDefaults];
      const cappedConfig =
        nextConfig.length > MAX_KEYBINDINGS_COUNT
          ? nextConfig.slice(-MAX_KEYBINDINGS_COUNT)
          : nextConfig;
      if (nextConfig.length > MAX_KEYBINDINGS_COUNT) {
        yield* Effect.logWarning("truncating keybindings config to max entries", {
          path: input.keybindingsConfigPath,
          maxEntries: MAX_KEYBINDINGS_COUNT,
        });
      }

      yield* input.writeConfigAtomically(cappedConfig);
      yield* input.invalidateResolvedConfigCache;
    }),
  );
}

export function makeStartWatcher(input: {
  readonly keybindingsConfigPath: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly watcherScope: Scope.Scope;
  readonly revalidateAndEmit: Effect.Effect<void, KeybindingsConfigError>;
}) {
  return Effect.gen(function* () {
    const keybindingsConfigDir = input.path.dirname(input.keybindingsConfigPath);
    const keybindingsConfigFile = input.path.basename(input.keybindingsConfigPath);
    const keybindingsConfigPathResolved = input.path.resolve(input.keybindingsConfigPath);

    yield* input.fileSystem.makeDirectory(keybindingsConfigDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: input.keybindingsConfigPath,
            detail: "failed to prepare keybindings config directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = input.revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    // Debounce watch events so the file is fully written before we read it.
    // Editors emit multiple events per save (truncate, write, rename) and
    // `fs.watch` can fire before the content has been flushed to disk.
    const debouncedKeybindingsEvents = input.fileSystem.watch(keybindingsConfigDir).pipe(
      Stream.filter((event) => {
        return (
          event.path === keybindingsConfigFile ||
          event.path === input.keybindingsConfigPath ||
          input.path.resolve(keybindingsConfigDir, event.path) === keybindingsConfigPathResolved
        );
      }),
      Stream.debounce(Duration.millis(100)),
    );

    yield* Stream.runForEach(debouncedKeybindingsEvents, () => revalidateAndEmitSafely).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(input.watcherScope),
      Effect.asVoid,
    );
  });
}
