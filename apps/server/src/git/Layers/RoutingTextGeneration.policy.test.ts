import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  DEFAULT_SERVER_SETTINGS,
  TextGenerationError,
  type ModelSelection,
} from "@bigbud/contracts";
import { makeInternalTextGenerationRouter } from "./RoutingTextGeneration.ts";
import type { TextGenerationShape } from "../Services/TextGeneration.ts";
import type { ServerSettingsService } from "../../ws/serverSettings.ts";
import type { OpencodeServerManager } from "../../provider/Services/Opencode/ServerManager.ts";

const operations = [
  "generateCommitMessage",
  "generatePrContent",
  "generateBranchName",
  "generateThreadTitle",
  "generateThreadElevatorSummary",
  "generatePromptSuggestion",
] as const;
const preference: ModelSelection = { provider: "codex", model: "user-configured" };
const successful: ModelSelection = {
  provider: "claudeAgent",
  model: "last-successful",
  options: { effort: "high" },
};
const result = {
  subject: "Subject",
  body: "Body",
  title: "Title",
  summary: "Summary",
  branch: "branch",
  suggestion: "Suggestion",
};

function service(
  method: (input: {
    modelSelection: ModelSelection;
  }) => Effect.Effect<typeof result, TextGenerationError>,
): TextGenerationShape {
  return {
    generateCommitMessage: method,
    generatePrContent: method,
    generateBranchName: method,
    generateThreadTitle: method,
    generateThreadElevatorSummary: method,
    generatePromptSuggestion: method,
  };
}

function fixture(selection: ModelSelection | null = preference) {
  const failed = vi.fn(
    (_input: {
      modelSelection: ModelSelection;
    }): Effect.Effect<typeof result, TextGenerationError> =>
      Effect.fail(new TextGenerationError({ operation: "fixture", detail: "Rejected model" })),
  );
  const passed = vi.fn(
    (_input: {
      modelSelection: ModelSelection;
    }): Effect.Effect<typeof result, TextGenerationError> => Effect.succeed(result),
  );
  const router = makeInternalTextGenerationRouter({
    codex: service(failed),
    claude: service(passed),
    cursor: service(passed),
    serverSettingsService: {
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        textGenerationModelSelection: selection,
      }),
    } as unknown as typeof ServerSettingsService.Service,
    opencodeServerManager: {} as typeof OpencodeServerManager.Service,
  });
  const input = {
    cwd: "/fixture",
    modelSelection: { provider: "copilot", model: "selected-but-not-successful" },
    successfulModelSelection: successful,
    message: "Message",
    transcript: "Transcript",
    branch: "branch",
    stagedSummary: "Changes",
    stagedPatch: "Patch",
    baseBranch: "main",
    headBranch: "feature",
    commitSummary: "Commit",
    diffSummary: "Diff",
    diffPatch: "Patch",
  };
  return { router, failed, passed, input };
}

describe("central internal-generation routing policy", () => {
  it("staged title recovery ignores the override and attempts only its verified thread pair", async () => {
    const test = fixture();
    test.passed.mockReturnValueOnce(
      Effect.fail(
        new TextGenerationError({
          operation: "generateThreadTitle",
          detail: "Verified pair unavailable",
        }),
      ),
    );
    await Effect.runPromiseExit(
      test.router.generateThreadTitle({
        ...test.input,
        modelSelection: preference,
        verifiedThreadModelOnly: true,
      }),
    );
    expect(test.failed).not.toHaveBeenCalled();
    expect(test.passed).toHaveBeenCalledTimes(1);
    expect(test.passed.mock.calls[0]?.[0].modelSelection).toEqual(successful);
  });
  it("never substitutes the override when exact-thread recovery lacks verified evidence", async () => {
    const test = fixture();
    await Effect.runPromiseExit(
      test.router.generateThreadTitle({
        ...test.input,
        modelSelection: preference,
        successfulModelSelection: null,
        verifiedThreadModelOnly: true,
      }),
    );
    expect(test.failed).not.toHaveBeenCalled();
    expect(test.passed).not.toHaveBeenCalled();
  });
  it("tries the successful pair when the preferred model returns an unusable placeholder title", async () => {
    const test = fixture();
    test.failed.mockReturnValueOnce(Effect.succeed({ ...result, title: "New thread" }));
    const generated = await Effect.runPromise(
      test.router.generateThreadTitle({ ...test.input, modelSelection: preference }),
    );
    expect(generated.title).toBe("Title");
    expect(test.failed).toHaveBeenCalledTimes(1);
    expect(test.passed).toHaveBeenCalledTimes(1);
  });
  it.each(operations)("%s tries only the configured and successful pairs", async (operation) => {
    const test = fixture();
    await Effect.runPromise<unknown, TextGenerationError>(
      test.router[operation](test.input as never),
    );
    expect(test.failed).toHaveBeenCalledTimes(1);
    expect(test.failed.mock.calls[0]?.[0].modelSelection).toEqual(preference);
    expect(test.passed).toHaveBeenCalledTimes(1);
    expect(test.passed.mock.calls[0]?.[0].modelSelection).toEqual(successful);
  });
  it("ignores an unproven selected model and does not invent a threadless default", async () => {
    const test = fixture(null);
    await Effect.runPromise(
      test.router
        .generateThreadTitle({
          ...test.input,
          modelSelection: preference,
          successfulModelSelection: null,
        })
        .pipe(Effect.flip),
    );
    expect(test.failed).not.toHaveBeenCalled();
    expect(test.passed).not.toHaveBeenCalled();
  });
  it("rejects invalid input before calling either provider", async () => {
    const test = fixture();
    await Effect.runPromise(
      test.router
        .generateThreadElevatorSummary({
          ...test.input,
          modelSelection: preference,
          transcript: " ",
        })
        .pipe(Effect.flip),
    );
    expect(test.failed).not.toHaveBeenCalled();
    expect(test.passed).not.toHaveBeenCalled();
  });
  it("reports the actual fallback provider for generated suggestion provenance", async () => {
    const test = fixture();
    const generated = await Effect.runPromise(
      test.router.generatePromptSuggestion({ ...test.input, modelSelection: preference }),
    );
    expect(generated.actualModelSelection).toEqual(successful);
  });
});
