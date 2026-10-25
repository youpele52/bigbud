import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { makeGeneratePromptSuggestion } from "./TextGeneration.promptSuggestion.ts";

describe("generated prompt suggestion", () => {
  it.effect("runs the provider's JSON runner with the suggestion prompt and thread model", () =>
    Effect.gen(function* () {
      const calls: Array<{ prompt: string; model: string }> = [];
      const generate = makeGeneratePromptSuggestion({
        provider: "codex",
        run: (args) =>
          Effect.sync(() => {
            calls.push({ prompt: args.prompt, model: args.modelSelection.model });
            return { suggestion: "Add tests for the parser" };
          }),
      });
      const result = yield* generate({
        cwd: "/tmp",
        transcript: "USER:\nSplit the parser\n\nASSISTANT:\nDone.",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
      });
      assert.deepEqual(result, { suggestion: "Add tests for the parser" });
      assert.equal(calls[0]?.model, "gpt-5-codex");
      assert.include(calls[0]?.prompt ?? "", "Split the parser");
      assert.include(calls[0]?.prompt ?? "", "between 15 and 150 characters");
    }),
  );

  it.effect("rejects a model selection for another provider", () =>
    Effect.gen(function* () {
      const generate = makeGeneratePromptSuggestion({
        provider: "codex",
        run: () => Effect.succeed({ suggestion: "never" }),
      });
      const error = yield* Effect.flip(
        generate({
          cwd: "/tmp",
          transcript: "USER:\nhi",
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-5" },
        }),
      );
      assert.equal(error.operation, "generatePromptSuggestion");
    }),
  );
});
