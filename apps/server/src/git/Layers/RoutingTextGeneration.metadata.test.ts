import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import type { ModelSelection } from "@bigbud/contracts/orchestration/orchestration.provider";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";

import { makeInternalTextGenerationRouter } from "./RoutingTextGeneration.ts";
import type {
  MetadataTextGenerationAttempt,
  TextGenerationShape,
} from "../Services/TextGeneration.ts";
import type { ServerSettingsService } from "../../ws/serverSettings.ts";
import type { OpencodeServerManager } from "../../provider/Services/Opencode/ServerManager.ts";

function fixture(provider: "codex" | "claudeAgent" | "cursor", fail = false) {
  const beforeDispatch = vi.fn(() => Effect.void);
  const selection: ModelSelection =
    provider === "codex"
      ? { provider, model: "captured", options: { reasoningEffort: "high", fastMode: true } }
      : provider === "claudeAgent"
        ? { provider, model: "captured", options: { effort: "high" } }
        : { provider, model: "captured" };
  const metadataAttempt: MetadataTextGenerationAttempt = {
    selection,
    executionTarget: "local",
    providerSettings: DEFAULT_SERVER_SETTINGS.providers,
    beforeDispatch,
  };
  const generated = {
    title: "Repair durable metadata recovery",
    summary: "Repairs metadata recovery.",
  };
  const method = vi.fn(
    (input: { modelSelection: ModelSelection; metadataAttempt?: MetadataTextGenerationAttempt }) =>
      Effect.gen(function* () {
        expect(input.modelSelection).toEqual(selection);
        expect(input.metadataAttempt?.providerSettings).toEqual(DEFAULT_SERVER_SETTINGS.providers);
        yield* input.metadataAttempt!.beforeDispatch();
        if (fail)
          return yield* new TextGenerationError({
            operation: "fixture",
            detail: "rejected",
            metadataOutcome: "failed",
          });
        return generated;
      }),
  );
  const unexpected = vi.fn(() => Effect.die("Unexpected provider substitution"));
  const service = (generate: typeof method | typeof unexpected): TextGenerationShape => ({
    generateCommitMessage: unexpected,
    generatePrContent: unexpected,
    generateBranchName: unexpected,
    generateThreadTitle: generate,
    generateThreadElevatorSummary: generate,
    generatePromptSuggestion: unexpected,
  });
  const readSettings = vi.fn(() => DEFAULT_SERVER_SETTINGS);
  const router = makeInternalTextGenerationRouter({
    codex: service(provider === "codex" ? method : unexpected),
    claude: service(provider === "claudeAgent" ? method : unexpected),
    cursor: service(provider === "cursor" ? method : unexpected),
    serverSettingsService: {
      getSettings: Effect.sync(readSettings),
    } as unknown as typeof ServerSettingsService.Service,
    opencodeServerManager: {} as typeof OpencodeServerManager.Service,
  });
  const input = {
    cwd: "/fixture",
    message: "Repair recovery",
    transcript: "User: repair recovery",
    modelSelection: { provider: "copilot", model: "unrelated-current-model" } as ModelSelection,
    successfulModelSelection: {
      provider: "claudeAgent",
      model: "unrelated-successful-model",
    } as ModelSelection,
    metadataAttempt,
  };
  return { router, input, beforeDispatch, method, unexpected, readSettings, selection, generated };
}

describe("metadata-only exact router", () => {
  it.each(["codex", "claudeAgent", "cursor"] as const)(
    "calls only the captured %s path",
    async (provider) => {
      for (const operation of ["generateThreadTitle", "generateThreadElevatorSummary"] as const) {
        const f = fixture(provider);
        expect(
          await Effect.runPromise<unknown, TextGenerationError>(f.router[operation](f.input)),
        ).toEqual({
          ...f.generated,
          actualModelSelection: f.selection,
        });
        expect(f.method).toHaveBeenCalledTimes(1);
        expect(f.beforeDispatch).toHaveBeenCalledTimes(1);
        expect(f.unexpected).not.toHaveBeenCalled();
        expect(f.readSettings).not.toHaveBeenCalled();
      }
    },
  );

  it("does not run a hidden successful-model fallback on an actual failed attempt", async () => {
    const f = fixture("codex", true);
    const error = await Effect.runPromise(f.router.generateThreadTitle(f.input).pipe(Effect.flip));
    expect(error.metadataOutcome).toBe("failed");
    expect(f.method).toHaveBeenCalledTimes(1);
    expect(f.unexpected).not.toHaveBeenCalled();
    expect(f.readSettings).not.toHaveBeenCalled();
  });
});
