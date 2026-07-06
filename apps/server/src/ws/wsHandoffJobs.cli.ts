import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";
import {
  type CodexModelSelection,
  type ClaudeModelSelection,
  TextGenerationError,
} from "@bigbud/contracts";
import {
  normalizeClaudeModelOptionsWithCapabilities,
  normalizeCodexModelOptionsWithCapabilities,
  resolveApiModelId,
} from "@bigbud/shared/model";

import {
  readStreamAsString,
  safeUnlink,
  writeTempFile,
} from "../git/Layers/CodexTextGeneration.helpers.ts";
import { normalizeCliError, toJsonSchemaObject } from "../git/Utils.ts";
import { getClaudeModelCapabilities } from "../provider/Layers/Claude/Provider.ts";
import { getCodexModelCapabilities } from "../provider/Layers/Codex/Provider.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ServerSettingsShape } from "./serverSettings.ts";
import {
  ClaudeOutputEnvelope,
  HANDOFF_TIMEOUT_MS,
  HandoffOutputSchema,
} from "./wsHandoffJobs.shared.ts";

export type HandoffJobDeps = {
  readonly commandSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly serverSettings: ServerSettingsShape;
};

function timeoutHandoffGeneration<A, R>(effect: Effect.Effect<A, TextGenerationError, R>) {
  return effect.pipe(
    Effect.scoped,
    Effect.timeoutOption(HANDOFF_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadHandoff",
              detail: "Handoff generation timed out.",
            }),
          ),
        onSome: (value) => Effect.succeed(value),
      }),
    ),
  );
}

export function generateClaudeHandoff(
  deps: HandoffJobDeps,
  input: {
    readonly cwd: string;
    readonly prompt: string;
    readonly modelSelection: ClaudeModelSelection;
  },
) {
  const jsonSchema = JSON.stringify(toJsonSchemaObject(HandoffOutputSchema));
  return timeoutHandoffGeneration(
    Effect.gen(function* () {
      const normalizedOptions = normalizeClaudeModelOptionsWithCapabilities(
        getClaudeModelCapabilities(input.modelSelection.model),
        input.modelSelection.options,
      );
      const claudeSettings = yield* deps.serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.claudeAgent),
        Effect.catch(() => Effect.undefined),
      );
      const child = yield* deps.commandSpawner
        .spawn(
          ChildProcess.make(
            claudeSettings?.binaryPath || "claude",
            [
              "-p",
              input.prompt,
              "--output-format",
              "json",
              "--json-schema",
              jsonSchema,
              "--model",
              resolveApiModelId(input.modelSelection),
              ...(normalizedOptions?.effort ? ["--effort", normalizedOptions.effort] : []),
              "--dangerously-skip-permissions",
            ],
            {
              cwd: input.cwd,
              shell: process.platform === "win32",
            },
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError(
              "claude",
              "generateThreadHandoff",
              cause,
              "Failed to spawn Claude CLI",
            ),
          ),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString("generateThreadHandoff", child.stdout),
          readStreamAsString("generateThreadHandoff", child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError(
                "claude",
                "generateThreadHandoff",
                cause,
                "Failed to read Claude CLI exit code",
              ),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError((cause) =>
          normalizeCliError(
            "claude",
            "generateThreadHandoff",
            cause,
            "Failed to read Claude CLI output",
          ),
        ),
      );
      if (exitCode !== 0) {
        return yield* new TextGenerationError({
          operation: "generateThreadHandoff",
          detail:
            stderr.trim().length > 0 ? stderr.trim() : "Claude CLI exited with a non-zero status.",
        });
      }
      const envelope = yield* Schema.decodeEffect(Schema.fromJsonString(ClaudeOutputEnvelope))(
        stdout,
      ).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadHandoff",
              detail: "Claude CLI returned unexpected output format.",
              cause,
            }),
          ),
        ),
      );
      return envelope.structured_output.markdown.trim();
    }),
  ).pipe(
    Effect.catchTag("TextGenerationError", (error) =>
      Effect.fail(
        error.detail === "Handoff generation timed out."
          ? new TextGenerationError({
              operation: "generateThreadHandoff",
              detail: "Claude handoff generation timed out.",
            })
          : error,
      ),
    ),
  );
}

export function generateCodexHandoff(
  deps: HandoffJobDeps,
  input: {
    readonly cwd: string;
    readonly prompt: string;
    readonly modelSelection: CodexModelSelection;
  },
) {
  return timeoutHandoffGeneration(
    Effect.gen(function* () {
      const schemaPath = yield* writeTempFile(
        deps.fileSystem,
        "generateThreadHandoff",
        "codex-handoff-schema",
        JSON.stringify(toJsonSchemaObject(HandoffOutputSchema)),
      );
      const outputPath = yield* writeTempFile(
        deps.fileSystem,
        "generateThreadHandoff",
        "codex-handoff-output",
        "",
      );
      const codexSettings = yield* deps.serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.codex),
        Effect.catch(() => Effect.undefined),
      );
      const normalizedOptions = normalizeCodexModelOptionsWithCapabilities(
        getCodexModelCapabilities(input.modelSelection.model),
        input.modelSelection.options,
      );

      const cleanup = Effect.all(
        [schemaPath, outputPath].map((filePath) => safeUnlink(deps.fileSystem, filePath)),
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid);

      return yield* Effect.gen(function* () {
        const child = yield* deps.commandSpawner
          .spawn(
            ChildProcess.make(
              codexSettings?.binaryPath || "codex",
              [
                "exec",
                "--ephemeral",
                "--skip-git-repo-check",
                "-s",
                "read-only",
                "--model",
                input.modelSelection.model,
                "--config",
                `model_reasoning_effort="${input.modelSelection.options?.reasoningEffort ?? "low"}"`,
                ...(normalizedOptions?.fastMode ? ["--config", `service_tier="fast"`] : []),
                "--output-schema",
                schemaPath,
                "--output-last-message",
                outputPath,
                "-",
              ],
              {
                cwd: input.cwd,
                env: {
                  ...process.env,
                  ...(codexSettings?.homePath ? { CODEX_HOME: codexSettings.homePath } : {}),
                },
                shell: process.platform === "win32",
                stdin: {
                  stream: Stream.encodeText(Stream.make(input.prompt)),
                },
              },
            ),
          )
          .pipe(
            Effect.mapError((cause) =>
              normalizeCliError(
                "codex",
                "generateThreadHandoff",
                cause,
                "Failed to spawn Codex CLI",
              ),
            ),
          );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            readStreamAsString("generateThreadHandoff", child.stdout),
            readStreamAsString("generateThreadHandoff", child.stderr),
            child.exitCode.pipe(
              Effect.mapError((cause) =>
                normalizeCliError(
                  "codex",
                  "generateThreadHandoff",
                  cause,
                  "Failed to read Codex CLI exit code",
                ),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) {
          return yield* new TextGenerationError({
            operation: "generateThreadHandoff",
            detail:
              stderr.trim().length > 0
                ? stderr.trim()
                : stdout.trim() || "Codex CLI exited with a non-zero status.",
          });
        }
        const rawOutput = yield* deps.fileSystem.readFileString(outputPath).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: "generateThreadHandoff",
                detail: "Failed to read Codex handoff output.",
                cause,
              }),
          ),
        );
        const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(HandoffOutputSchema))(
          rawOutput,
        ).pipe(
          Effect.catchTag("SchemaError", (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation: "generateThreadHandoff",
                detail: "Codex CLI returned invalid structured output.",
                cause,
              }),
            ),
          ),
        );
        return decoded.markdown.trim();
      }).pipe(Effect.ensuring(cleanup));
    }),
  ).pipe(
    Effect.catchTag("TextGenerationError", (error) =>
      Effect.fail(
        error.detail === "Handoff generation timed out."
          ? new TextGenerationError({
              operation: "generateThreadHandoff",
              detail: "Codex handoff generation timed out.",
            })
          : error,
      ),
    ),
  );
}
