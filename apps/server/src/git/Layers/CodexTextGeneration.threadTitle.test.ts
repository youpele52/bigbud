import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";

import { TextGeneration } from "../Services/TextGeneration.ts";
import {
  CodexTextGenerationTestLayer,
  DEFAULT_TEST_MODEL_SELECTION,
  withFakeCodexEnv,
} from "./CodexTextGeneration.test.helpers.ts";

it.layer(CodexTextGenerationTestLayer)("CodexTextGenerationLive", (it) => {
  it.effect("generates thread titles and trims them for sidebar use", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title:
            '  "Investigate websocket reconnect regressions after worktree restore"  \nignored line',
        }),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Please investigate websocket reconnect regressions after a worktree restore.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.title).toBe("Investigate websocket reconnect regressions aft...");
      }),
    ),
  );

  it.effect("falls back when thread title normalization becomes whitespace-only", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: '  """   """  ',
        }),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Name this thread.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.title).toBe("New thread");
      }),
    ),
  );

  it.effect("trims whitespace exposed after quote removal in thread titles", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: `  "' hello world '"  `,
        }),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "Name this thread.",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        });

        expect(generated.title).toBe("hello world");
      }),
    ),
  );
});
