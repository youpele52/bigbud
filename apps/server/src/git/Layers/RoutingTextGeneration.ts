/**
 * RoutingTextGeneration – Dispatches text generation requests to either the
 * Codex CLI or Claude CLI implementation based on the provider in each
 * request input.
 *
 * When `modelSelection.provider` is `"claudeAgent"` the request is forwarded to
 * the Claude layer. Copilot is not implemented for git text generation yet, so
 * it currently falls back to Codex alongside the default `undefined` route.
 *
 * @module RoutingTextGeneration
 */
import { Effect, Layer, ServiceMap } from "effect";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
} from "@bigbud/contracts";

import {
  TextGeneration,
  type TextGenerationProvider,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";
import {
  generateCopilotThreadTitleNative,
  generateOpencodeThreadTitleNative,
  generatePiThreadTitleNative,
} from "./ProviderNativeThreadTitleGeneration.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { OpencodeServerManager } from "../../provider/Services/OpencodeServerManager.ts";

// ---------------------------------------------------------------------------
// Internal service tags so both concrete layers can coexist.
// ---------------------------------------------------------------------------

class CodexTextGen extends ServiceMap.Service<CodexTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}

class ClaudeTextGen extends ServiceMap.Service<ClaudeTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}

export function normalizeTextGenerationModelSelection(
  modelSelection: ModelSelection,
): ModelSelection {
  switch (modelSelection.provider) {
    case "claudeAgent":
    case "codex":
      return modelSelection;
    case "pi":
    case "opencode":
      return {
        provider: "claudeAgent",
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.claudeAgent,
      };
    case "copilot":
    case "cursor":
    default:
      return {
        provider: "codex",
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
      };
  }
}

export function normalizeGitTextGenerationModelSelection(
  modelSelection: ModelSelection,
): ModelSelection {
  return normalizeTextGenerationModelSelection(modelSelection);
}

// ---------------------------------------------------------------------------
// Routing implementation
// ---------------------------------------------------------------------------

const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGen;
  const claude = yield* ClaudeTextGen;
  const serverSettingsService = yield* ServerSettingsService;
  const opencodeServerManager = yield* OpencodeServerManager;

  const route = (provider?: TextGenerationProvider): TextGenerationShape =>
    provider === "claudeAgent" ? claude : codex;

  return {
    generateCommitMessage: (input) => {
      const modelSelection = normalizeGitTextGenerationModelSelection(input.modelSelection);
      return route(modelSelection.provider).generateCommitMessage({
        ...input,
        modelSelection,
      });
    },
    generatePrContent: (input) => {
      const modelSelection = normalizeGitTextGenerationModelSelection(input.modelSelection);
      return route(modelSelection.provider).generatePrContent({
        ...input,
        modelSelection,
      });
    },
    generateBranchName: (input) => {
      const modelSelection = normalizeGitTextGenerationModelSelection(input.modelSelection);
      return route(modelSelection.provider).generateBranchName({
        ...input,
        modelSelection,
      });
    },
    generateThreadTitle: (input) => {
      switch (input.modelSelection.provider) {
        case "codex":
        case "claudeAgent":
          return route(input.modelSelection.provider).generateThreadTitle(input);
        case "pi":
          return generatePiThreadTitleNative(
            {
              serverSettingsService,
              opencodeServerManager,
            },
            {
              cwd: input.cwd,
              message: input.message,
              ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
              modelSelection: input.modelSelection,
            },
          );
        case "copilot":
          return generateCopilotThreadTitleNative(
            {
              serverSettingsService,
              opencodeServerManager,
            },
            {
              cwd: input.cwd,
              message: input.message,
              ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
              modelSelection: input.modelSelection,
            },
          );
        case "cursor":
          return route("codex").generateThreadTitle({
            ...input,
            modelSelection: {
              provider: "codex",
              model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
            },
          });
        case "opencode":
          return generateOpencodeThreadTitleNative(
            {
              serverSettingsService,
              opencodeServerManager,
            },
            {
              cwd: input.cwd,
              message: input.message,
              ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
              modelSelection: input.modelSelection,
            },
          );
      }
    },
  } satisfies TextGenerationShape;
});

const InternalCodexLayer = Layer.effect(
  CodexTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(CodexTextGenerationLive));

const InternalClaudeLayer = Layer.effect(
  ClaudeTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(ClaudeTextGenerationLive));

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(Layer.provide(InternalCodexLayer), Layer.provide(InternalClaudeLayer));
