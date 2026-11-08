/** Structured text generation through the shared Claude CLI, including its CLIProxy harness. */
import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { TextGenerationError, ThreadId } from "@bigbud/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@bigbud/shared/git";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadElevatorSummaryPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  sanitizeElevatorSummary,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../Utils.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { CliProxyLifecycle } from "../../provider/Services/CliProxy/Lifecycle.ts";
import { CliProxyLifecycleLive } from "../../provider/Layers/CliProxy/Lifecycle.ts";
import { resolveCliProxyRuntimeConfig } from "../../provider/Layers/CliProxy/RuntimeConfig.ts";
import { makeGeneratePromptSuggestion } from "./TextGeneration.promptSuggestion.ts";
import { makeClaudeJsonRunner } from "./ClaudeTextGeneration.runner.ts";

const makeClaudeTextGeneration = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverSettingsService = yield* ServerSettingsService;
  const lifecycle = yield* CliProxyLifecycle;
  const runClaudeJson = makeClaudeJsonRunner(commandSpawner, serverSettingsService);

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "ClaudeTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
      ...(input.skillContent !== undefined ? { skillContent: input.skillContent } : {}),
    });
    if (input.modelSelection.provider !== "claudeAgent") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }
    const generated = yield* runClaudeJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "ClaudeTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });
    if (input.modelSelection.provider !== "claudeAgent") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }
    const generated = yield* runClaudeJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "ClaudeTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    if (input.modelSelection.provider !== "claudeAgent") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }
    const generated = yield* runClaudeJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return { branch: sanitizeBranchFragment(generated.branch) };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "ClaudeTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    const selection = input.modelSelection;
    if (selection.provider !== "claudeAgent" && selection.provider !== "cliProxy") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }
    const harness =
      selection.provider === "cliProxy"
        ? (yield* resolveCliProxyRuntimeConfig({
            threadId: ThreadId.makeUnsafe(`internal-title:${crypto.randomUUID()}`),
            provider: "cliProxy",
            modelSelection: selection,
            cwd: input.cwd,
            runtimeMode: "approval-required",
          }).pipe(
            Effect.provideService(ServerSettingsService, serverSettingsService),
            Effect.provideService(CliProxyLifecycle, lifecycle),
            // Runtime resolution may inspect credentials; do not propagate its raw cause.
            Effect.mapError(
              () =>
                new TextGenerationError({
                  operation: "generateThreadTitle",
                  kind: "provider",
                  detail: "CLIProxy Claude harness is unavailable for the selected model.",
                }),
            ),
          )).harness
        : undefined;
    const generated = yield* runClaudeJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection:
        selection.provider === "cliProxy" ? { ...selection, provider: "claudeAgent" } : selection,
      ...(harness ? { harness } : {}),
    });
    return { title: sanitizeThreadTitle(generated.title) };
  });

  const generateThreadElevatorSummary: TextGenerationShape["generateThreadElevatorSummary"] =
    Effect.fn("ClaudeTextGeneration.generateThreadElevatorSummary")(function* (input) {
      const { prompt, outputSchema } = buildThreadElevatorSummaryPrompt({
        transcript: input.transcript,
        attachments: input.attachments,
      });
      if (input.modelSelection.provider !== "claudeAgent") {
        return yield* new TextGenerationError({
          operation: "generateThreadElevatorSummary",
          detail: "Invalid model selection.",
        });
      }
      const generated = yield* runClaudeJson({
        operation: "generateThreadElevatorSummary",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });
      return { summary: sanitizeElevatorSummary(generated.summary) };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateThreadElevatorSummary,
    generatePromptSuggestion: makeGeneratePromptSuggestion({
      provider: "claudeAgent",
      run: ({ outputSchema, ...args }) =>
        runClaudeJson({
          ...args,
          operation: "generatePromptSuggestion",
          outputSchemaJson: outputSchema,
        }),
    }),
  } satisfies TextGenerationShape;
});

export const ClaudeTextGenerationLive = Layer.effect(TextGeneration, makeClaudeTextGeneration).pipe(
  Layer.provide(CliProxyLifecycleLive),
);
