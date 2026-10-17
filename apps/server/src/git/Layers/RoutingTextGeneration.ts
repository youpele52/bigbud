/** Exact-model dispatch for every internal text-generation operation. */
import { Effect, Layer, ServiceMap } from "effect";
import { TextGenerationError, type ModelSelection } from "@bigbud/contracts";

import { TextGeneration, type TextGenerationShape } from "../Services/TextGeneration.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";
import { CursorTextGenerationLive } from "./CursorTextGeneration.ts";
import {
  generateCopilotThreadTitleNative,
  generateOpencodeThreadElevatorSummaryNative,
  generateOpencodeThreadTitleNative,
  generatePiThreadTitleNative,
} from "./ProviderNativeThreadTitleGeneration.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { OpencodeServerManager } from "../../provider/Services/Opencode/ServerManager.ts";
import { runInternalTextGeneration } from "./InternalTextGenerationPolicy.ts";
import { sanitizeElevatorSummary } from "../Utils.ts";
import { shouldRetryGeneratedThreadTitle } from "../../orchestration/Layers/ProviderCommandReactorHelpers.ts";

class CodexTextGen extends ServiceMap.Service<CodexTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}
class ClaudeTextGen extends ServiceMap.Service<ClaudeTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}
class CursorTextGen extends ServiceMap.Service<CursorTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/CursorTextGen",
) {}

/** Build one shared routing policy; injectable native services keep policy tests provider-free. */
export function makeInternalTextGenerationRouter(deps: {
  readonly codex: TextGenerationShape;
  readonly claude: TextGenerationShape;
  readonly cursor: TextGenerationShape;
  readonly serverSettingsService: typeof ServerSettingsService.Service;
  readonly opencodeServerManager: typeof OpencodeServerManager.Service;
}): TextGenerationShape {
  const { codex, claude, cursor, serverSettingsService, opencodeServerManager } = deps;
  const nativeDeps = { serverSettingsService, opencodeServerManager };

  const route = (selection: ModelSelection) => {
    switch (selection.provider) {
      case "codex":
        return codex;
      case "claudeAgent":
        return claude;
      case "cursor":
        return cursor;
      default:
        return null;
    }
  };
  const unsupported = (operation: string, selection: ModelSelection) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: `Provider '${selection.provider}' does not support ${operation} with the selected model.`,
      }),
    );

  const run = <A extends object>(
    operation: keyof TextGenerationShape,
    input: {
      readonly successfulModelSelection?: ModelSelection | null;
      readonly message?: string;
      readonly transcript?: string;
      readonly attachments?: ReadonlyArray<unknown> | undefined;
      readonly titleSeed?: string | undefined;
      readonly verifiedThreadModelOnly?: boolean;
    },
    generate: (selection: ModelSelection) => Effect.Effect<A, TextGenerationError>,
  ) =>
    Effect.gen(function* () {
      for (const field of ["message", "transcript"] as const) {
        if (
          field in input &&
          typeof input[field] === "string" &&
          input[field].trim().length === 0 &&
          !(
            field === "message" &&
            "attachments" in input &&
            Array.isArray(input.attachments) &&
            input.attachments.length > 0
          )
        ) {
          return yield* new TextGenerationError({
            operation,
            detail: `Invalid input: ${field} is empty.`,
            kind: "invalid-input",
          });
        }
      }
      const settings = yield* serverSettingsService.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to load provider settings: ${cause.message}`,
              cause,
            }),
        ),
      );
      return yield* runInternalTextGeneration({
        operation,
        preference: input.verifiedThreadModelOnly ? null : settings.textGenerationModelSelection,
        successful: input.successfulModelSelection ?? null,
        generate: (selection) =>
          !settings.providers[selection.provider]?.enabled
            ? Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: `Provider '${selection.provider}' is disabled.`,
                }),
              )
            : generate(selection).pipe(
                Effect.flatMap((result) => {
                  const text =
                    operation === "generateThreadElevatorSummary" &&
                    "summary" in result &&
                    typeof result.summary === "string"
                      ? sanitizeElevatorSummary(result.summary)
                      : operation === "generateThreadTitle" &&
                          "title" in result &&
                          typeof result.title === "string"
                        ? result.title.trim()
                        : null;
                  const weakTitle =
                    operation === "generateThreadTitle" &&
                    text !== null &&
                    shouldRetryGeneratedThreadTitle({
                      generatedTitle: text,
                      ...(input.titleSeed !== undefined ? { titleSeed: input.titleSeed } : {}),
                    });
                  return text === "" || weakTitle
                    ? Effect.fail(
                        new TextGenerationError({
                          operation,
                          detail: "Provider returned unusable output.",
                          kind: "provider",
                        }),
                      )
                    : Effect.succeed({ ...result, actualModelSelection: selection });
                }),
              ),
      });
    });

  return {
    generateCommitMessage: (input) =>
      run("generateCommitMessage", input, (selection) => {
        const service = route(selection);
        return service
          ? service.generateCommitMessage({ ...input, modelSelection: selection })
          : unsupported("generateCommitMessage", selection);
      }),
    generatePrContent: (input) =>
      run("generatePrContent", input, (selection) => {
        const service = route(selection);
        return service
          ? service.generatePrContent({ ...input, modelSelection: selection })
          : unsupported("generatePrContent", selection);
      }),
    generateBranchName: (input) =>
      run("generateBranchName", input, (selection) => {
        const service = route(selection);
        return service
          ? service.generateBranchName({ ...input, modelSelection: selection })
          : unsupported("generateBranchName", selection);
      }),
    generateThreadTitle: (input) =>
      run("generateThreadTitle", input, (selection) => {
        const resolved = { ...input, modelSelection: selection };
        const service = route(selection);
        if (service) return service.generateThreadTitle(resolved);
        switch (selection.provider) {
          case "pi":
            return generatePiThreadTitleNative(nativeDeps, { ...input, modelSelection: selection });
          case "copilot":
            return generateCopilotThreadTitleNative(nativeDeps, {
              ...input,
              modelSelection: selection,
            });
          case "opencode":
            return generateOpencodeThreadTitleNative(nativeDeps, {
              ...input,
              modelSelection: selection,
            });
          default:
            return unsupported("generateThreadTitle", selection);
        }
      }),
    generateThreadElevatorSummary: (input) =>
      run("generateThreadElevatorSummary", input, (selection) => {
        const resolved = { ...input, modelSelection: selection };
        if (selection.provider === "opencode")
          return generateOpencodeThreadElevatorSummaryNative(nativeDeps, {
            ...input,
            modelSelection: selection,
          });
        const service = route(selection);
        return service
          ? service.generateThreadElevatorSummary(resolved)
          : unsupported("generateThreadElevatorSummary", selection);
      }),
    generatePromptSuggestion: (input) =>
      run("generatePromptSuggestion", input, (selection) => {
        const service = route(selection);
        return service
          ? service.generatePromptSuggestion({ ...input, modelSelection: selection })
          : unsupported("generatePromptSuggestion", selection);
      }),
  } satisfies TextGenerationShape;
}

const makeRoutingTextGeneration = Effect.gen(function* () {
  return makeInternalTextGenerationRouter({
    codex: yield* CodexTextGen,
    claude: yield* ClaudeTextGen,
    cursor: yield* CursorTextGen,
    serverSettingsService: yield* ServerSettingsService,
    opencodeServerManager: yield* OpencodeServerManager,
  });
});

const InternalCodexLayer = Layer.effect(CodexTextGen, TextGeneration.asEffect()).pipe(
  Layer.provide(CodexTextGenerationLive),
);
const InternalClaudeLayer = Layer.effect(ClaudeTextGen, TextGeneration.asEffect()).pipe(
  Layer.provide(ClaudeTextGenerationLive),
);
const InternalCursorLayer = Layer.effect(CursorTextGen, TextGeneration.asEffect()).pipe(
  Layer.provide(CursorTextGenerationLive),
);

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(
  Layer.provide(InternalCodexLayer),
  Layer.provide(InternalClaudeLayer),
  Layer.provide(InternalCursorLayer),
);
