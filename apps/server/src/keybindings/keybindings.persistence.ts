import {
  KeybindingRule,
  KeybindingsConfig,
  KeybindingsConfigError,
  type ServerConfigIssue,
} from "@bigbud/contracts";
import { fromLenientJson } from "@bigbud/shared/schemaJson";
import { Cause, Effect, type FileSystem, type Path, Predicate, Schema, SchemaGetter } from "effect";

import { ResolvedKeybindingFromConfig } from "./keybindings.compiler";

const RawKeybindingsEntries = fromLenientJson(Schema.Array(Schema.Unknown));
const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);
const PrettyJsonString = SchemaGetter.parseJson<string>().compose(
  SchemaGetter.stringifyJson({ space: 2 }),
);
const KeybindingsConfigPrettyJson = KeybindingsConfigJson.pipe(
  Schema.encode({
    decode: PrettyJsonString,
    encode: PrettyJsonString,
  }),
);

function trimIssueMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : "Invalid keybindings configuration.";
}

function malformedConfigIssue(detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.malformed-config",
    message: trimIssueMessage(detail),
  };
}

function invalidEntryIssue(index: number, detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.invalid-entry",
    index,
    message: trimIssueMessage(detail),
  };
}

export interface RuntimeCustomKeybindingsConfig {
  readonly keybindings: readonly KeybindingRule[];
  readonly issues: readonly ServerConfigIssue[];
}

export function makeReadConfigExists(
  fs: FileSystem.FileSystem,
  keybindingsConfigPath: string,
): Effect.Effect<boolean, KeybindingsConfigError> {
  return fs.exists(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          detail: "failed to access keybindings config",
          cause,
        }),
    ),
  );
}

export function makeReadRawConfig(
  fs: FileSystem.FileSystem,
  keybindingsConfigPath: string,
): Effect.Effect<string, KeybindingsConfigError> {
  return fs.readFileString(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          detail: "failed to read keybindings config",
          cause,
        }),
    ),
  );
}

export function makeLoadWritableCustomKeybindingsConfig(input: {
  readonly keybindingsConfigPath: string;
  readonly readConfigExists: Effect.Effect<boolean, KeybindingsConfigError>;
  readonly readRawConfig: Effect.Effect<string, KeybindingsConfigError>;
}) {
  return Effect.fn(function* (): Effect.fn.Return<
    readonly KeybindingRule[],
    KeybindingsConfigError
  > {
    if (!(yield* input.readConfigExists)) {
      return [];
    }

    const rawConfig = yield* input.readRawConfig.pipe(
      Effect.flatMap(Schema.decodeEffect(RawKeybindingsEntries)),
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: input.keybindingsConfigPath,
            detail: "expected JSON array",
            cause,
          }),
      ),
    );

    return yield* Effect.forEach(rawConfig, (entry) =>
      Effect.gen(function* () {
        const decodedRule = Schema.decodeUnknownExit(KeybindingRule)(entry);
        if (decodedRule._tag === "Failure") {
          yield* Effect.logWarning("ignoring invalid keybinding entry", {
            path: input.keybindingsConfigPath,
            entry,
            error: Cause.pretty(decodedRule.cause),
          });
          return null;
        }
        const resolved = Schema.decodeExit(ResolvedKeybindingFromConfig)(decodedRule.value);
        if (resolved._tag === "Failure") {
          yield* Effect.logWarning("ignoring invalid keybinding entry", {
            path: input.keybindingsConfigPath,
            entry,
            error: Cause.pretty(resolved.cause),
          });
          return null;
        }
        return decodedRule.value;
      }),
    ).pipe(Effect.map((values) => values.filter(Predicate.isNotNull)));
  });
}

export function makeLoadRuntimeCustomKeybindingsConfig(input: {
  readonly keybindingsConfigPath: string;
  readonly readConfigExists: Effect.Effect<boolean, KeybindingsConfigError>;
  readonly readRawConfig: Effect.Effect<string, KeybindingsConfigError>;
}) {
  return Effect.fn(function* (): Effect.fn.Return<
    RuntimeCustomKeybindingsConfig,
    KeybindingsConfigError
  > {
    if (!(yield* input.readConfigExists)) {
      return { keybindings: [], issues: [] };
    }

    const rawConfig = yield* input.readRawConfig;
    const decodedEntries = Schema.decodeUnknownExit(RawKeybindingsEntries)(rawConfig);
    if (decodedEntries._tag === "Failure") {
      const detail = `expected JSON array (${Cause.pretty(decodedEntries.cause)})`;
      return {
        keybindings: [],
        issues: [malformedConfigIssue(detail)],
      };
    }

    const keybindings: KeybindingRule[] = [];
    const issues: ServerConfigIssue[] = [];
    for (const [index, entry] of decodedEntries.value.entries()) {
      const decodedRule = Schema.decodeUnknownExit(KeybindingRule)(entry);
      if (decodedRule._tag === "Failure") {
        const detail = Cause.pretty(decodedRule.cause);
        issues.push(invalidEntryIssue(index, detail));
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: input.keybindingsConfigPath,
          index,
          entry,
          error: detail,
        });
        continue;
      }

      const resolvedRule = Schema.decodeExit(ResolvedKeybindingFromConfig)(decodedRule.value);
      if (resolvedRule._tag === "Failure") {
        const detail = Cause.pretty(resolvedRule.cause);
        issues.push(invalidEntryIssue(index, detail));
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: input.keybindingsConfigPath,
          index,
          entry,
          error: detail,
        });
        continue;
      }
      keybindings.push(decodedRule.value);
    }

    return { keybindings, issues };
  });
}

export function makeWriteConfigAtomically(input: {
  readonly keybindingsConfigPath: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  return (rules: readonly KeybindingRule[]) => {
    const tempPath = `${input.keybindingsConfigPath}.${process.pid}.${Date.now()}.tmp`;

    return Schema.encodeEffect(KeybindingsConfigPrettyJson)(rules).pipe(
      Effect.map((encoded) => `${encoded}\n`),
      Effect.tap(() =>
        input.fileSystem.makeDirectory(input.path.dirname(input.keybindingsConfigPath), {
          recursive: true,
        }),
      ),
      Effect.tap((encoded) => input.fileSystem.writeFileString(tempPath, encoded)),
      Effect.flatMap(() => input.fileSystem.rename(tempPath, input.keybindingsConfigPath)),
      Effect.ensuring(
        input.fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true })),
      ),
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: input.keybindingsConfigPath,
            detail: "failed to write keybindings config",
            cause,
          }),
      ),
    );
  };
}
