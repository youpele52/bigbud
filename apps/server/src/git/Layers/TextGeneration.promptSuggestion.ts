/**
 * Provider-agnostic generated prompt suggestion (Phase 7). Every text generation provider
 * reuses its own structured JSON runner; the prompt, the model check and the result shape
 * live here once.
 *
 * @module TextGeneration.promptSuggestion
 */
import { type ModelSelection, TextGenerationError } from "@bigbud/contracts";
import { Effect, Schema } from "effect";

import { buildPromptSuggestionPrompt } from "../Prompts.ts";
import type { TextGenerationShape } from "../Services/TextGeneration.ts";

export const PROMPT_SUGGESTION_OPERATION = "generatePromptSuggestion" as const;

type Selection<P extends ModelSelection["provider"]> = Extract<ModelSelection, { provider: P }>;

export function makeGeneratePromptSuggestion<P extends ModelSelection["provider"]>(input: {
  readonly provider: P;
  readonly run: (args: {
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: Schema.Struct<{ readonly suggestion: Schema.String }>;
    readonly modelSelection: Selection<P>;
  }) => Effect.Effect<{ readonly suggestion: string }, TextGenerationError>;
}): TextGenerationShape["generatePromptSuggestion"] {
  return Effect.fn("TextGeneration.generatePromptSuggestion")(function* (request) {
    if (request.modelSelection.provider !== input.provider) {
      return yield* new TextGenerationError({
        operation: PROMPT_SUGGESTION_OPERATION,
        detail: "Invalid model selection.",
      });
    }
    const { prompt, outputSchema } = buildPromptSuggestionPrompt({
      transcript: request.transcript,
    });
    const generated = yield* input.run({
      cwd: request.cwd,
      prompt,
      outputSchema,
      modelSelection: request.modelSelection as Selection<P>,
    });
    // Normalization and the 15–150 bound are applied by the attaching pipeline.
    return { suggestion: generated.suggestion };
  });
}
