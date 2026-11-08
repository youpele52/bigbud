import { Effect, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { TextGenerationError, type ClaudeModelSelection } from "@bigbud/contracts";
import {
  normalizeClaudeModelOptionsWithCapabilities,
  resolveApiModelId,
} from "@bigbud/shared/model";
import type { ServerSettingsService } from "../../ws/serverSettings.ts";
import type { ClaudeHarnessConfig } from "../../provider/Layers/Claude/Adapter.types.ts";
import { materializeClaudeQuerySettings } from "../../provider/Layers/Claude/Adapter.session.options.ts";
import { getClaudeModelCapabilities } from "../../provider/Layers/Claude/Provider.ts";
import { normalizeCliError, toJsonSchemaObject } from "../Utils.ts";
import type { TextGenerationShape } from "../Services/TextGeneration.ts";

const ClaudeOutputEnvelope = Schema.Struct({ structured_output: Schema.Unknown });

/** One structured Claude CLI implementation for direct Claude and its resolved CLIProxy harness. */
export function makeClaudeJsonRunner(
  commandSpawner: typeof ChildProcessSpawner.ChildProcessSpawner.Service,
  serverSettingsService: typeof ServerSettingsService.Service,
) {
  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
    protectedHarness: boolean,
  ) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        protectedHarness
          ? new TextGenerationError({ operation, detail: "Failed to collect Claude CLI output." })
          : normalizeCliError("claude", operation, cause, "Failed to collect process output"),
      ),
    );

  return Effect.fn("runClaudeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
    harness,
  }: {
    operation: keyof TextGenerationShape;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ClaudeModelSelection;
    harness?: ClaudeHarnessConfig;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const jsonSchemaStr = JSON.stringify(toJsonSchemaObject(outputSchemaJson));
    const normalizedOptions = normalizeClaudeModelOptionsWithCapabilities(
      harness?.modelCapabilities ?? getClaudeModelCapabilities(modelSelection.model),
      modelSelection.options,
    );
    const settings = {
      ...(harness?.protectedSettingsEnvironment
        ? { env: harness.protectedSettingsEnvironment, apiKeyHelper: "" }
        : {}),
      ...(typeof normalizedOptions?.thinking === "boolean"
        ? { alwaysThinkingEnabled: normalizedOptions.thinking }
        : {}),
      ...(normalizedOptions?.fastMode ? { fastMode: true } : {}),
    };
    const claudeSettings = yield* serverSettingsService.getSettings.pipe(
      Effect.map((value) => value.providers.claudeAgent),
      Effect.catch(() => Effect.undefined),
    );
    const runClaudeCommand = Effect.fn("runClaudeJson.runClaudeCommand")(function* () {
      // Reuse the harness's restricted file materialization; credentials never enter argv.
      const lease = harness?.protectedSettingsEnvironment
        ? yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () => materializeClaudeQuerySettings({ settings }),
              catch: () =>
                new TextGenerationError({
                  operation,
                  detail: "Could not prepare protected Claude settings.",
                }),
            }),
            (value) => Effect.promise(value.cleanup),
          )
        : null;
      const settingsArgument =
        lease?.options.settings ??
        (Object.keys(settings).length ? JSON.stringify(settings) : undefined);
      const command = ChildProcess.make(
        harness?.binaryPath || claudeSettings?.binaryPath || "claude",
        [
          "-p",
          prompt,
          "--output-format",
          "json",
          "--json-schema",
          jsonSchemaStr,
          "--model",
          harness ? modelSelection.model : resolveApiModelId(modelSelection),
          ...(normalizedOptions?.effort ? ["--effort", normalizedOptions.effort] : []),
          ...(harness?.settingSources
            ? ["--setting-sources", harness.settingSources.join(",")]
            : []),
          ...(typeof settingsArgument === "string" ? ["--settings", settingsArgument] : []),
          "--dangerously-skip-permissions",
        ],
        {
          cwd,
          shell: process.platform === "win32",
          ...(harness?.environment ? { env: { ...process.env, ...harness.environment } } : {}),
          stdin: { stream: Stream.encodeText(Stream.make(prompt)) },
        },
      );
      const child = yield* commandSpawner.spawn(command).pipe(
        Effect.mapError((cause) =>
          harness
            ? new TextGenerationError({
                operation,
                detail: "Failed to spawn the configured Claude CLI.",
              })
            : normalizeCliError("claude", operation, cause, "Failed to spawn Claude CLI process"),
        ),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout, !!harness),
          readStreamAsString(operation, child.stderr, !!harness),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              harness
                ? new TextGenerationError({
                    operation,
                    detail: "Failed to read Claude CLI exit code.",
                  })
                : normalizeCliError(
                    "claude",
                    operation,
                    cause,
                    "Failed to read Claude CLI exit code",
                  ),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim();
        return yield* new TextGenerationError({
          operation,
          detail:
            !harness && detail
              ? `Claude CLI command failed: ${detail}`
              : `Claude CLI command failed with code ${exitCode}.`,
        });
      }
      return stdout;
    });
    const rawStdout = yield* runClaudeCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(180_000),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Claude CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );
    const envelope = yield* Schema.decodeEffect(Schema.fromJsonString(ClaudeOutputEnvelope))(
      rawStdout,
    ).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Claude CLI returned unexpected output format.",
            ...(harness ? {} : { cause }),
          }),
        ),
      ),
    );
    return yield* Schema.decodeEffect(outputSchemaJson)(envelope.structured_output).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Claude returned invalid structured output.",
            ...(harness ? {} : { cause }),
          }),
        ),
      ),
    );
  });
}
