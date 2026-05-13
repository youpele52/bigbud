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
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  type ThreadTitleGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import { sanitizeCommitSubject, sanitizePrTitle, sanitizeThreadTitle } from "../Utils.ts";

const CURSOR_TIMEOUT_MS = 180_000;
const DEFAULT_CURSOR_SETTINGS: CursorSettings = {
  enabled: false,
  binaryPath: "",
  apiEndpoint: "",
  customModels: [],
};

function mapCursorTextGenerationError(
  operation:
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle",
  detail: string,
  cause: unknown,
): TextGenerationError {
  return new TextGenerationError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isTextGenerationError(error: unknown): error is TextGenerationError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "TextGenerationError"
  );
}

function extractJsonObjectString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaping = false;

  for (let index = 0; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = inString;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return candidate.slice(start, index + 1);
      }
    }
  }

  return candidate;
}

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
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
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

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const CursorTextGenerationLive = Layer.effect(TextGeneration, makeCursorTextGeneration);
