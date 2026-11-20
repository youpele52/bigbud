import { Effect, FileSystem, Layer, Path } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { TextGenerationError } from "@bigbud/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@bigbud/shared/git";

import { ServerConfig } from "../../startup/config.ts";
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
import { materializeImageAttachments } from "./CodexTextGeneration.helpers.ts";
import { makeGeneratePromptSuggestion } from "./TextGeneration.promptSuggestion.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { makeCodexJsonRunner } from "./CodexTextGeneration.runner.ts";

const makeCodexTextGeneration = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig);
  const serverSettingsService = yield* Effect.service(ServerSettingsService);
  const runCodexJson = makeCodexJsonRunner(fileSystem, commandSpawner, serverSettingsService);

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CodexTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
      ...(input.skillContent !== undefined ? { skillContent: input.skillContent } : {}),
    });
    if (input.modelSelection.provider !== "codex")
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    const generated = yield* runCodexJson({
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
    "CodexTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });
    if (input.modelSelection.provider !== "codex")
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    const generated = yield* runCodexJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
  });
  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "CodexTextGeneration.generateBranchName",
  )(function* (input) {
    const { imagePaths } = yield* materializeImageAttachments(
      path,
      serverConfig,
      fileSystem,
      input.attachments,
    );
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    if (input.modelSelection.provider !== "codex")
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    const generated = yield* runCodexJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      imagePaths,
      modelSelection: input.modelSelection,
    });
    return { branch: sanitizeBranchFragment(generated.branch) };
  });
  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CodexTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { imagePaths } = yield* materializeImageAttachments(
      path,
      serverConfig,
      fileSystem,
      input.attachments,
    );
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });
    if (input.modelSelection.provider !== "codex")
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    const generated = yield* runCodexJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      imagePaths,
      modelSelection: input.modelSelection,
      ...(input.metadataAttempt ? { metadataAttempt: input.metadataAttempt } : {}),
    });
    return { title: sanitizeThreadTitle(generated.title) };
  });
  const generateThreadElevatorSummary: TextGenerationShape["generateThreadElevatorSummary"] =
    Effect.fn("CodexTextGeneration.generateThreadElevatorSummary")(function* (input) {
      const { imagePaths } = yield* materializeImageAttachments(
        path,
        serverConfig,
        fileSystem,
        input.attachments,
      );
      const { prompt, outputSchema } = buildThreadElevatorSummaryPrompt({
        transcript: input.transcript,
        attachments: input.attachments,
      });
      if (input.modelSelection.provider !== "codex")
        return yield* new TextGenerationError({
          operation: "generateThreadElevatorSummary",
          detail: "Invalid model selection.",
        });
      const generated = yield* runCodexJson({
        operation: "generateThreadElevatorSummary",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        imagePaths,
        modelSelection: input.modelSelection,
        ...(input.metadataAttempt ? { metadataAttempt: input.metadataAttempt } : {}),
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
      provider: "codex",
      run: ({ outputSchema, ...args }) =>
        runCodexJson({
          ...args,
          operation: "generatePromptSuggestion",
          outputSchemaJson: outputSchema,
        }),
    }),
  } satisfies TextGenerationShape;
});

export const CodexTextGenerationLive = Layer.effect(TextGeneration, makeCodexTextGeneration);
