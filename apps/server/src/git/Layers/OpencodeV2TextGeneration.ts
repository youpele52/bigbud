import { realpath } from "node:fs/promises";
import { Effect, Layer, Schema } from "effect";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { OpencodeV2ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider.ts";
import { resolveOpencodeV2ConnectionMode } from "@bigbud/shared/serverSettings";
import { hasOpencodeV2NativeTrust } from "@bigbud/shared/opencodeNativeTrust";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@bigbud/shared/git";
import { TextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadElevatorSummaryPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  sanitizeCommitSubject,
  sanitizeElevatorSummary,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "../Utils.ts";
import { makeGeneratePromptSuggestion } from "./TextGeneration.promptSuggestion.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { ThreadToolsActivation } from "../../provider/Services/OpencodeV2/ThreadToolsActivation.ts";
import { connectV2TextGeneration } from "../../provider/Layers/OpencodeV2/TextGeneration.connection.ts";
import { makeV2AuxiliaryTextGenerator } from "../../provider/Layers/OpencodeV2/TextGeneration.native.ts";
import {
  runAuthorizedV2,
  currentV2RequestContext,
  runV2RequestContext,
} from "../../provider/Layers/OpencodeV2/Client.guard.ts";
import { v2SharedRegistrationFile } from "../../provider/Layers/OpencodeV2/SharedService.registration.ts";
import { V2TextGenerationUncertain } from "../../provider/Layers/OpencodeV2/TextGeneration.errors.ts";

export interface V2StructuredGenerationRequest<S extends Schema.Top> {
  readonly operation: keyof TextGenerationShape;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: OpencodeV2ModelSelection;
}
type Runner = <S extends Schema.Top>(
  input: V2StructuredGenerationRequest<S>,
) => Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]>;

/** Native text is not guaranteed JSON. Decode locally without retaining sensitive SDK causes. */
export function makeV2StructuredTextRunner(
  generate: (
    input: V2StructuredGenerationRequest<Schema.Top>,
    signal: AbortSignal,
  ) => Promise<string>,
): Runner {
  return (input) =>
    Effect.gen(function* () {
      const text = yield* Effect.tryPromise({
        try: (signal) =>
          generate(
            {
              ...input,
              prompt: `${input.prompt}\n\nReturn only a JSON object matching this schema:\n${JSON.stringify(toJsonSchemaObject(input.outputSchema))}`,
            },
            signal,
          ),
        catch: (error) =>
          new TextGenerationError({
            operation: input.operation,
            ...(Schema.is(V2TextGenerationUncertain)(error)
              ? { uncertaintyId: error.nativeSessionId }
              : {}),
            kind: Schema.is(V2TextGenerationUncertain)(error)
              ? "uncertain"
              : error instanceof DOMException && error.name === "AbortError"
                ? "cancelled"
                : "provider",
            detail: Schema.is(V2TextGenerationUncertain)(error)
              ? "OpenCode v2 generation dispatch is unconfirmed. No automatic retry; verify original work before starting another request."
              : error instanceof DOMException && error.name === "AbortError"
                ? "OpenCode v2 auxiliary generation cancelled."
                : "OpenCode v2 auxiliary generation failed or timed out; uncertain native history was retained.",
          }),
      });
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(text).pipe(
        Effect.mapError(
          () =>
            new TextGenerationError({
              operation: input.operation,
              detail: "OpenCode v2 returned invalid structured output.",
            }),
        ),
      );
    });
}

/** All six operations share existing prompts, schema decoding and output normalization. */
export function makeOpencodeV2TextGeneration(run: Runner): TextGenerationShape {
  const generate = <S extends Schema.Top>(
    operation: keyof TextGenerationShape,
    input: { cwd: string; modelSelection: { provider: string } },
    prompt: { prompt: string; outputSchema: S },
  ) =>
    input.modelSelection.provider !== "opencodeV2"
      ? Effect.fail(new TextGenerationError({ operation, detail: "Invalid model selection." }))
      : run({
          ...prompt,
          operation,
          cwd: input.cwd,
          modelSelection: input.modelSelection as OpencodeV2ModelSelection,
        });
  return {
    generateCommitMessage: (input) =>
      generate(
        "generateCommitMessage",
        input,
        buildCommitMessagePrompt({ ...input, includeBranch: input.includeBranch === true }),
      ).pipe(
        Effect.map((result) => ({
          subject: sanitizeCommitSubject(result.subject),
          body: result.body.trim(),
          ...("branch" in result && typeof result.branch === "string"
            ? { branch: sanitizeFeatureBranchName(result.branch) }
            : {}),
        })),
      ),
    generatePrContent: (input) =>
      generate("generatePrContent", input, buildPrContentPrompt(input)).pipe(
        Effect.map((result) => ({
          title: sanitizePrTitle(result.title),
          body: result.body.trim(),
        })),
      ),
    generateBranchName: (input) =>
      generate("generateBranchName", input, buildBranchNamePrompt(input)).pipe(
        Effect.map((result) => ({ branch: sanitizeBranchFragment(result.branch) })),
      ),
    generateThreadTitle: (input) =>
      generate("generateThreadTitle", input, buildThreadTitlePrompt(input)).pipe(
        Effect.map((result) => ({ title: sanitizeThreadTitle(result.title) })),
      ),
    generateThreadElevatorSummary: (input) =>
      generate(
        "generateThreadElevatorSummary",
        input,
        buildThreadElevatorSummaryPrompt(input),
      ).pipe(Effect.map((result) => ({ summary: sanitizeElevatorSummary(result.summary) }))),
    generatePromptSuggestion: makeGeneratePromptSuggestion({
      provider: "opencodeV2",
      run: (input) => run({ ...input, operation: "generatePromptSuggestion" }),
    }),
  };
}

const makeLive = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const { consent } = yield* ThreadToolsActivation;
  const native = makeV2AuxiliaryTextGenerator({
    connect: (signal) => {
      const transport = currentV2RequestContext()?.transport;
      if (!transport) throw new Error("V2 auxiliary native authority unavailable.");
      return connectV2TextGeneration(transport, signal);
    },
  });
  const run = makeV2StructuredTextRunner(async (input, signal) => {
    const config = settings.currentSnapshot?.()?.settings.providers.opencodeV2;
    if (
      !config?.enabled ||
      resolveOpencodeV2ConnectionMode(config) !== "shared" ||
      !hasOpencodeV2NativeTrust(config)
    )
      throw new DOMException(
        "V2 native execution is disabled or its connection mode changed.",
        "AbortError",
      );
    return runAuthorizedV2(
      consent,
      config.serviceFile?.trim() || v2SharedRegistrationFile(),
      async () => {
        const context = currentV2RequestContext()!;
        try {
          const transport = await realpath(context.transport);
          context.permit.assertCurrent();
          const directory = await realpath(input.cwd);
          context.permit.assertCurrent();
          return await runV2RequestContext({ ...context, transport, operationSignal: signal }, () =>
            native({
              directory,
              operation: input.operation,
              selection: input.modelSelection,
              signal,
              prompt: input.prompt,
            }),
          );
        } catch (error) {
          if (Schema.is(V2TextGenerationUncertain)(error)) throw error;
          if (signal.aborted || context.permit.signal.aborted)
            throw new DOMException("V2 auxiliary authority revoked.", "AbortError");
          throw error;
        }
      },
    );
  });
  return makeOpencodeV2TextGeneration(run);
});

export const OpencodeV2TextGenerationLive = Layer.effect(TextGeneration, makeLive);
