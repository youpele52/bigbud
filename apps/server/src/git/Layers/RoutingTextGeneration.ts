/** Exact-model dispatch for every internal text-generation operation. */
import { Effect, Layer, ServiceMap } from "effect";
import { TextGenerationError, type ModelSelection } from "@bigbud/contracts";

import {
  TextGeneration,
  type TextGenerationShape,
  type InternalTextGenerationContext,
} from "../Services/TextGeneration.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";
import { CursorTextGenerationLive } from "./CursorTextGeneration.ts";
import { OpencodeV2TextGenerationLive } from "./OpencodeV2TextGeneration.ts";
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

/** A durable claim may await settings changes; its captured candidate must remain the one dispatched. */
function capture(selection: ModelSelection | null | undefined): ModelSelection | null {
  if (!selection) return null;
  const snapshot = structuredClone(selection);
  if (snapshot.options) Object.freeze(snapshot.options);
  return Object.freeze(snapshot);
}

class CodexTextGen extends ServiceMap.Service<CodexTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}
class ClaudeTextGen extends ServiceMap.Service<ClaudeTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}
class CursorTextGen extends ServiceMap.Service<CursorTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/CursorTextGen",
) {}
class OpencodeV2TextGen extends ServiceMap.Service<OpencodeV2TextGen, TextGenerationShape>()(
  "bigbud/git/Layers/RoutingTextGeneration/OpencodeV2TextGen",
) {}

/** Build one shared routing policy; injectable native services keep policy tests provider-free. */
export function makeInternalTextGenerationRouter(deps: {
  readonly codex: TextGenerationShape;
  readonly claude: TextGenerationShape;
  readonly cursor: TextGenerationShape;
  readonly opencodeV2?: TextGenerationShape;
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
      case "opencodeV2":
        return deps.opencodeV2 ?? null;
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
    input: InternalTextGenerationContext & {
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
      const preference = input.verifiedThreadModelOnly
        ? null
        : capture(settings.textGenerationModelSelection);
      const successful = capture(input.successfulModelSelection);
      const enabled = new Set(
        Object.entries(settings.providers)
          .filter(([, value]) => value.enabled)
          .map(([provider]) => provider),
      );
      return yield* runInternalTextGeneration({
        operation,
        preference,
        successful,
        generate: (selection) =>
          !enabled.has(selection.provider)
            ? Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: `Provider '${selection.provider}' is disabled.`,
                }),
              )
            : (selection.provider === "opencodeV2" && input.beforeV2Dispatch
                ? input
                    .beforeV2Dispatch(selection)
                    .pipe(Effect.andThen(Effect.suspend(() => generate(selection))))
                : generate(selection)
              ).pipe(
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
    opencodeV2: yield* OpencodeV2TextGen,
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
const InternalOpencodeV2Layer = Layer.effect(OpencodeV2TextGen, TextGeneration.asEffect()).pipe(
  Layer.provide(OpencodeV2TextGenerationLive),
);

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(
  Layer.provide(InternalCodexLayer),
  Layer.provide(InternalClaudeLayer),
  Layer.provide(InternalCursorLayer),
  Layer.provide(InternalOpencodeV2Layer),
);
