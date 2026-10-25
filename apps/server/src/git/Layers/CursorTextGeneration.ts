import { Effect, Layer, Option, Ref, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  TextGenerationError,
  type CursorModelSelection,
  type CursorSettings,
} from "@bigbud/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@bigbud/shared/git";

import {
  applyCursorAcpModelSelection,
  makeCursorAcpRuntime,
} from "../../provider/acp/CursorAcpSupport.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadElevatorSummaryPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  type ThreadElevatorSummaryGenerationResult,
  type ThreadTitleGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import {
  sanitizeCommitSubject,
  sanitizeElevatorSummary,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../Utils.ts";
import {
  CURSOR_TIMEOUT_MS,
  type CursorTextGenerationOperation,
  DEFAULT_CURSOR_SETTINGS,
  extractJsonObjectString,
  isTextGenerationError,
  mapCursorTextGenerationError,
} from "./CursorTextGeneration.helpers.ts";
import { makeGeneratePromptSuggestion } from "./TextGeneration.promptSuggestion.ts";

const makeCursorTextGeneration = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverSettingsService = yield* Effect.service(ServerSettingsService);

  const loadCursorSettings = Effect.map(
    serverSettingsService.getSettings,
    (settings) => settings.providers.cursor,
  ).pipe(Effect.catch(() => Effect.succeed(DEFAULT_CURSOR_SETTINGS)));

  const runCursorJson = Effect.fn("runCursorJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
    cursorSettings,
  }: {
    operation: CursorTextGenerationOperation;
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: CursorModelSelection;
    cursorSettings: CursorSettings;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const outputRef = yield* Ref.make("");
    const runtime = yield* makeCursorAcpRuntime({
      cursorSettings,
      childProcessSpawner: commandSpawner,
      cwd,
      clientInfo: { name: "bigbud-git-text", version: "0.0.0" },
    }).pipe(
      Effect.mapError((cause) =>
        mapCursorTextGenerationError(
          operation,
          "Failed to start Cursor ACP runtime for text generation.",
          cause,
        ),
      ),
    );

    yield* runtime.handleSessionUpdate((notification) => {
      const update = notification.update;
      if (update.sessionUpdate !== "agent_message_chunk") {
        return Effect.void;
      }
      const content = update.content;
      if (content.type !== "text") {
        return Effect.void;
      }
      return Ref.update(outputRef, (current) => current + content.text);
    });

    const promptResult = yield* Effect.gen(function* () {
      yield* runtime.start();
      yield* Effect.ignore(runtime.setMode("ask"));
      yield* applyCursorAcpModelSelection({
        runtime,
        model: modelSelection.model,
        modelOptions: modelSelection.options,
        mapError: ({ cause, configId, step }) =>
          mapCursorTextGenerationError(
            operation,
            step === "set-config-option"
              ? `Failed to set Cursor ACP config option "${configId}" for text generation.`
              : "Failed to set Cursor ACP base model for text generation.",
            cause,
          ),
      });

      return yield* runtime.prompt({
        prompt: [{ type: "text", text: prompt }],
      });
    }).pipe(
      Effect.timeoutOption(CURSOR_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Cursor Agent request timed out.",
              }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : mapCursorTextGenerationError(operation, "Cursor ACP request failed.", cause),
      ),
    );

    const rawResult = (yield* Ref.get(outputRef)).trim();
    if (!rawResult) {
      return yield* new TextGenerationError({
        operation,
        detail:
          promptResult.stopReason === "cancelled"
            ? "Cursor ACP request was cancelled."
            : "Cursor Agent returned empty output.",
      });
    }

    return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))(
      extractJsonObjectString(rawResult),
    ).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Cursor Agent returned invalid structured output.",
            cause,
          }),
        ),
      ),
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : mapCursorTextGenerationError(operation, "Cursor ACP text generation failed.", cause),
      ),
      Effect.scoped,
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CursorTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
      ...(input.skillContent !== undefined ? { skillContent: input.skillContent } : {}),
    });

    if (input.modelSelection.provider !== "cursor") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCursorJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      cursorSettings: yield* loadCursorSettings,
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
    "CursorTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    if (input.modelSelection.provider !== "cursor") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCursorJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      cursorSettings: yield* loadCursorSettings,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "CursorTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "cursor") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCursorJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      cursorSettings: yield* loadCursorSettings,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CursorTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "cursor") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCursorJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
      cursorSettings: yield* loadCursorSettings,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    } satisfies ThreadTitleGenerationResult;
  });

  const generateThreadElevatorSummary: TextGenerationShape["generateThreadElevatorSummary"] =
    Effect.fn("CursorTextGeneration.generateThreadElevatorSummary")(function* (input) {
      const { prompt, outputSchema } = buildThreadElevatorSummaryPrompt({
        transcript: input.transcript,
        attachments: input.attachments,
      });

      if (input.modelSelection.provider !== "cursor") {
        return yield* new TextGenerationError({
          operation: "generateThreadElevatorSummary",
          detail: "Invalid model selection.",
        });
      }

      const generated = yield* runCursorJson({
        operation: "generateThreadElevatorSummary",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
        cursorSettings: yield* loadCursorSettings,
      });

      return {
        summary: sanitizeElevatorSummary(generated.summary),
      } satisfies ThreadElevatorSummaryGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateThreadElevatorSummary,
    generatePromptSuggestion: makeGeneratePromptSuggestion({
      provider: "cursor",
      run: ({ outputSchema, ...args }) =>
        Effect.gen(function* () {
          return yield* runCursorJson({
            ...args,
            operation: "generatePromptSuggestion",
            outputSchemaJson: outputSchema,
            cursorSettings: yield* loadCursorSettings,
          });
        }),
    }),
  } satisfies TextGenerationShape;
});

export const CursorTextGenerationLive = Layer.effect(TextGeneration, makeCursorTextGeneration);
