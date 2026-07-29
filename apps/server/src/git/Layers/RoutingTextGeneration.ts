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
  PROVIDER_KINDS,
  TextGenerationError,
  type ModelSelection,
  type ProviderKind,
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
import { resolveProviderWorkload } from "../../provider/providerWorkloadSupport.ts";

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

function genericTextGenerationFallbackOrder(provider: ProviderKind): ReadonlyArray<ProviderKind> {
  return provider === "pi" || provider === "kilocode" || provider === "opencode"
    ? ["claudeAgent", "codex", "cursor"]
    : ["codex", "claudeAgent", "cursor"];
}

export function normalizeTextGenerationModelSelection(
  modelSelection: ModelSelection,
): ModelSelection {
  switch (modelSelection.provider) {
    case "claudeAgent":
    case "cliProxy":
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
    case "copilot":
    case "devin":
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

function unsupportedTextGeneration(provider: ProviderKind, operation: string, reason?: string) {
  return Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        reason ??
        `Provider '${provider}' does not support unattended text generation, and no supported fallback is available.`,
    }),
  );
}

const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGen;
  const claude = yield* ClaudeTextGen;
  const cursor = yield* CursorTextGen;
  const serverSettingsService = yield* ServerSettingsService;
  const opencodeServerManager = yield* OpencodeServerManager;

  const resolveTextGenerationSelection = Effect.fn("resolveTextGenerationSelection")(
    function* (input: {
      readonly requested: ModelSelection;
      readonly operation: string;
      readonly fallbackOrder?: ReadonlyArray<ProviderKind>;
      readonly normalizeGeneric?: boolean;
    }) {
      const settings = yield* serverSettingsService.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: `Failed to load provider settings: ${cause.message}`,
              cause,
            }),
        ),
      );
      const availableProviderKinds = PROVIDER_KINDS.filter(
        (provider) => settings.providers[provider].enabled,
      );
      const resolution = resolveProviderWorkload({
        requested: input.requested,
        workload: "unattendedTextGeneration",
        availableProviderKinds,
        fallbackOrder:
          input.fallbackOrder ?? genericTextGenerationFallbackOrder(input.requested.provider),
      });
      if (!resolution.actual) {
        return yield* unsupportedTextGeneration(
          input.requested.provider,
          input.operation,
          resolution.reason ?? undefined,
        );
      }
      const actual =
        input.normalizeGeneric === false
          ? resolution.actual
          : normalizeTextGenerationModelSelection(resolution.actual);
      yield* Effect.annotateCurrentSpan({
        "text-generation.requested-provider": resolution.requested.provider,
        "text-generation.actual-provider": actual.provider,
        ...(resolution.reason ? { "text-generation.fallback-reason": resolution.reason } : {}),
      });
      return actual;
    },
  );

  const route = (provider?: TextGenerationProvider): TextGenerationShape =>
    provider === "claudeAgent" ? claude : provider === "cursor" ? cursor : codex;

  return {
    generateCommitMessage: (input) =>
      Effect.gen(function* () {
        const modelSelection = yield* resolveTextGenerationSelection({
          requested: input.modelSelection,
          operation: "generateCommitMessage",
        });
        const normalizedInput = normalizeGitCommitMessageGenerationInput({
          ...input,
          modelSelection,
        });
        return yield* route(normalizedInput.modelSelection.provider).generateCommitMessage(
          normalizedInput,
        );
      }),
    generatePrContent: (input) =>
      Effect.gen(function* () {
        const modelSelection = yield* resolveTextGenerationSelection({
          requested: input.modelSelection,
          operation: "generatePrContent",
        });
        const normalizedInput = normalizeGitPrContentGenerationInput({ ...input, modelSelection });
        return yield* route(normalizedInput.modelSelection.provider).generatePrContent(
          normalizedInput,
        );
      }),
    generateBranchName: (input) =>
      Effect.gen(function* () {
        const modelSelection = yield* resolveTextGenerationSelection({
          requested: input.modelSelection,
          operation: "generateBranchName",
        });
        const normalizedInput = normalizeGitBranchNameGenerationInput({ ...input, modelSelection });
        return yield* route(normalizedInput.modelSelection.provider).generateBranchName(
          normalizedInput,
        );
      }),
    generateThreadTitle: (input) =>
      Effect.gen(function* () {
        const modelSelection = yield* resolveTextGenerationSelection({
          requested: input.modelSelection,
          operation: "generateThreadTitle",
          fallbackOrder: ["codex", "claudeAgent", "cursor", "opencode", "copilot", "pi"],
          normalizeGeneric: false,
        });
        const resolvedInput = { ...input, modelSelection };
        switch (modelSelection.provider) {
          case "codex":
          case "claudeAgent":
          case "cursor":
            return yield* route(modelSelection.provider).generateThreadTitle(resolvedInput);
          case "pi":
            return yield* generatePiThreadTitleNative(
              { serverSettingsService, opencodeServerManager },
              {
                ...input,
                modelSelection,
              },
            );
          case "copilot":
            return yield* generateCopilotThreadTitleNative(
              { serverSettingsService, opencodeServerManager },
              {
                ...input,
                modelSelection,
              },
            );
          case "opencode":
            return yield* generateOpencodeThreadTitleNative(
              { serverSettingsService, opencodeServerManager },
              {
                ...input,
                modelSelection,
              },
            );
          default:
            return yield* route("codex").generateThreadTitle({
              ...input,
              modelSelection: {
                provider: "codex",
                model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
              },
            });
        }
      }),
    generateThreadElevatorSummary: (input) =>
      Effect.gen(function* () {
        const modelSelection = yield* resolveTextGenerationSelection({
          requested: input.modelSelection,
          operation: "generateThreadElevatorSummary",
          fallbackOrder: ["opencode", "codex", "claudeAgent", "cursor"],
          normalizeGeneric: false,
        });
        const resolvedInput = { ...input, modelSelection };
        if (modelSelection.provider === "opencode") {
          return yield* generateOpencodeThreadElevatorSummaryNative(
            { serverSettingsService, opencodeServerManager },
            {
              ...input,
              modelSelection,
            },
          );
        }
        const normalizedInput = normalizeThreadElevatorSummaryGenerationInput(resolvedInput);
        return yield* route(normalizedInput.modelSelection.provider).generateThreadElevatorSummary(
          normalizedInput,
        );
      }),
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
