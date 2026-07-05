/**
 * RoutingTextGeneration – Dispatches text generation requests to the
 * provider-native implementation selected in each request input.
 *
 * Codex, Claude, and Cursor have full text-generation implementations. Other
 * providers still route to the best-supported fallback or native thread-title
 * helpers where available.
 *
 * @module RoutingTextGeneration
 */
import { Effect, Layer, ServiceMap } from "effect";
import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  type ModelSelection,
} from "@bigbud/contracts";

import {
  type BranchNameGenerationInput,
  type CommitMessageGenerationInput,
  type ThreadElevatorSummaryGenerationInput,
  type PrContentGenerationInput,
  TextGeneration,
  type TextGenerationProvider,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
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

// ---------------------------------------------------------------------------
// Internal service tags so both concrete layers can coexist.
// ---------------------------------------------------------------------------

class CodexTextGen extends ServiceMap.Service<CodexTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}

class ClaudeTextGen extends ServiceMap.Service<ClaudeTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}

class CursorTextGen extends ServiceMap.Service<CursorTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/CursorTextGen",
) {}

export function normalizeTextGenerationModelSelection(
  modelSelection: ModelSelection,
): ModelSelection {
  switch (modelSelection.provider) {
    case "claudeAgent":
    case "codex":
    case "cursor":
      return modelSelection;
    case "pi":
    case "kilocode":
    case "opencode":
      return {
        provider: "claudeAgent",
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.claudeAgent,
      };
    case "devin":
    case "copilot":
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

export function normalizeGitCommitMessageGenerationInput(
  input: CommitMessageGenerationInput,
): CommitMessageGenerationInput {
  return {
    ...input,
    modelSelection: normalizeGitTextGenerationModelSelection(input.modelSelection),
  };
}

export function normalizeGitPrContentGenerationInput(
  input: PrContentGenerationInput,
): PrContentGenerationInput {
  return {
    ...input,
    modelSelection: normalizeGitTextGenerationModelSelection(input.modelSelection),
  };
}

export function normalizeGitBranchNameGenerationInput(
  input: BranchNameGenerationInput,
): BranchNameGenerationInput {
  return {
    ...input,
    modelSelection: normalizeGitTextGenerationModelSelection(input.modelSelection),
  };
}

export function normalizeThreadElevatorSummaryGenerationInput(
  input: ThreadElevatorSummaryGenerationInput,
): ThreadElevatorSummaryGenerationInput {
  return {
    ...input,
    modelSelection: normalizeTextGenerationModelSelection(input.modelSelection),
  };
}

// ---------------------------------------------------------------------------
// Routing implementation
// ---------------------------------------------------------------------------

const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGen;
  const claude = yield* ClaudeTextGen;
  const cursor = yield* CursorTextGen;
  const serverSettingsService = yield* ServerSettingsService;
  const opencodeServerManager = yield* OpencodeServerManager;

  const route = (provider?: TextGenerationProvider): TextGenerationShape =>
    provider === "claudeAgent" ? claude : provider === "cursor" ? cursor : codex;

  return {
    generateCommitMessage: (input) => {
      const normalizedInput = normalizeGitCommitMessageGenerationInput(input);
      return route(normalizedInput.modelSelection.provider).generateCommitMessage(normalizedInput);
    },
    generatePrContent: (input) => {
      const normalizedInput = normalizeGitPrContentGenerationInput(input);
      return route(normalizedInput.modelSelection.provider).generatePrContent(normalizedInput);
    },
    generateBranchName: (input) => {
      const normalizedInput = normalizeGitBranchNameGenerationInput(input);
      return route(normalizedInput.modelSelection.provider).generateBranchName(normalizedInput);
    },
    generateThreadTitle: (input) => {
      switch (input.modelSelection.provider) {
        case "codex":
        case "claudeAgent":
        case "cursor":
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
        default:
          return route("codex").generateThreadTitle(input);
      }
    },
    generateThreadElevatorSummary: (input) => {
      switch (input.modelSelection.provider) {
        case "opencode":
          return generateOpencodeThreadElevatorSummaryNative(
            {
              serverSettingsService,
              opencodeServerManager,
            },
            {
              cwd: input.cwd,
              transcript: input.transcript,
              ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
              modelSelection: input.modelSelection,
            },
          );
        default: {
          const normalizedInput = normalizeThreadElevatorSummaryGenerationInput(input);
          return route(normalizedInput.modelSelection.provider).generateThreadElevatorSummary(
            normalizedInput,
          );
        }
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

const InternalCursorLayer = Layer.effect(
  CursorTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(CursorTextGenerationLive));

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(
  Layer.provide(InternalCodexLayer),
  Layer.provide(InternalClaudeLayer),
  Layer.provide(InternalCursorLayer),
);
