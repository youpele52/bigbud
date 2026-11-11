import { Effect, Option, Schema, Stream, type Scope } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";
import type { FileSystem } from "effect/FileSystem";
import { TextGenerationError, type CodexModelSelection } from "@bigbud/contracts";

import type { MetadataTextGenerationAttempt } from "../Services/TextGeneration.ts";
import type { ServerSettingsService } from "../../ws/serverSettings.ts";
import { normalizeCliError, toJsonSchemaObject } from "../Utils.ts";
import { shouldEnableCodexCliFastMode } from "../../provider/Layers/Codex/Provider.cliOptions.ts";
import {
  readStreamAsString,
  safeUnlink,
  type CodexTextGenerationOperation,
  writeTempFile,
} from "./CodexTextGeneration.helpers.ts";

export function makeCodexJsonRunner(
  fileSystem: FileSystem,
  commandSpawner: typeof ChildProcessSpawner.ChildProcessSpawner.Service,
  serverSettingsService: typeof ServerSettingsService.Service,
) {
  return Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    imagePaths = [],
    cleanupPaths = [],
    modelSelection,
    metadataAttempt,
  }: {
    operation: CodexTextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    imagePaths?: ReadonlyArray<string>;
    cleanupPaths?: ReadonlyArray<string>;
    modelSelection: CodexModelSelection;
    metadataAttempt?: MetadataTextGenerationAttempt;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"] | Scope.Scope> {
    const schemaPath = yield* writeTempFile(
      fileSystem,
      operation,
      "codex-schema",
      JSON.stringify(toJsonSchemaObject(outputSchemaJson)),
    );
    const outputPath = yield* writeTempFile(fileSystem, operation, "codex-output", "");
    const codexSettings =
      metadataAttempt?.providerSettings.codex ??
      (yield* Effect.map(
        serverSettingsService.getSettings,
        (settings) => settings.providers.codex,
      ).pipe(Effect.catch(() => Effect.undefined)));

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* () {
      const fastMode = shouldEnableCodexCliFastMode({
        model: modelSelection.model,
        options: modelSelection.options,
        customModels: codexSettings?.customModels ?? [],
      });
      const reasoningEffort = modelSelection.options?.reasoningEffort ?? "low";
      const command = ChildProcess.make(
        codexSettings?.binaryPath || "codex",
        [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "--model",
          modelSelection.model,
          "--config",
          `model_reasoning_effort="${reasoningEffort}"`,
          ...(fastMode ? ["--config", `service_tier="fast"`] : []),
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        {
          env: {
            ...process.env,
            ...(codexSettings?.homePath ? { CODEX_HOME: codexSettings.homePath } : {}),
          },
          cwd,
          shell: process.platform === "win32",
          stdin: { stream: Stream.encodeText(Stream.make(prompt)) },
        },
      );
      // Durable intent is committed before a process can submit any paid work.
      if (metadataAttempt) yield* metadataAttempt.beforeDispatch();
      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
          ),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to read Codex CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim();
        return yield* new TextGenerationError({
          operation,
          detail: detail
            ? `Codex CLI command failed: ${detail}`
            : `Codex CLI command failed with code ${exitCode}.`,
          ...(metadataAttempt ? { metadataOutcome: "failed" as const } : {}),
        });
      }
    });
    const cleanup = Effect.all(
      [schemaPath, outputPath, ...cleanupPaths].map((filePath) => safeUnlink(fileSystem, filePath)),
      { concurrency: "unbounded" },
    ).pipe(Effect.asVoid);
    return yield* Effect.gen(function* () {
      yield* runCodexCommand().pipe(
        Effect.scoped,
        Effect.timeoutOption(180_000),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Codex CLI request timed out.",
                  ...(metadataAttempt ? { metadataOutcome: "uncertain" as const } : {}),
                }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );
      return yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read Codex output file.",
              cause,
            }),
        ),
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))),
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Codex returned invalid structured output.",
              cause,
              ...(metadataAttempt ? { metadataOutcome: "failed" as const } : {}),
            }),
          ),
        ),
      );
    }).pipe(Effect.ensuring(cleanup));
  }, Effect.scoped);
}
