import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import type { ServerSettingsService } from "../../ws/serverSettings.ts";
import type { OpencodeServerManager } from "../../provider/Services/Opencode/ServerManager.ts";
import { makeV2AuxiliaryTextGenerator } from "../../provider/Layers/OpencodeV2/TextGeneration.native.ts";
import {
  makeTextGenerationHttpFixture,
  textGenerationSelection,
} from "../../provider/Layers/OpencodeV2/TextGeneration.fixture.ts";
import {
  makeOpencodeV2TextGeneration,
  makeV2StructuredTextRunner,
} from "./OpencodeV2TextGeneration.ts";
import { makeInternalTextGenerationRouter } from "./RoutingTextGeneration.ts";
import { INTERNAL_TEXT_GENERATION_OPERATIONS } from "@bigbud/shared/internalTextGeneration";

const input = {
  cwd: "/fixture",
  modelSelection: textGenerationSelection,
  successfulModelSelection: textGenerationSelection,
  message: "Repair native generation routing",
  transcript: "User: repair text generation\nAssistant: fixed native routing",
  branch: "feature",
  stagedSummary: "Changes",
  stagedPatch: "Patch",
  includeBranch: true,
  skillContent: "CUSTOM COMMIT INSTRUCTIONS",
  baseBranch: "main",
  headBranch: "feature",
  commitSummary: "Commit",
  diffSummary: "Diff",
  diffPatch: "Patch",
};
const output = {
  subject: "Fix native generation",
  body: "Details",
  title: "Repair native generation",
  branch: "fix-native-generation",
  summary: "Implemented native text generation.",
  suggestion: "Add focused coverage for native generation.",
};

function fixture() {
  const http = makeTextGenerationHttpFixture();
  http.options.text = JSON.stringify(output);
  const native = makeV2AuxiliaryTextGenerator(http);
  const service = makeOpencodeV2TextGeneration(
    makeV2StructuredTextRunner((request, signal) =>
      native({
        operation: request.operation,
        directory: request.cwd,
        prompt: request.prompt,
        selection: request.modelSelection,
        signal,
      }),
    ),
  );
  const router = makeInternalTextGenerationRouter({
    codex: service,
    claude: service,
    cursor: service,
    opencodeV2: service,
    serverSettingsService: {
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          opencodeV2: { ...DEFAULT_SERVER_SETTINGS.providers.opencodeV2, enabled: true },
        },
        textGenerationModelSelection: textGenerationSelection,
      }),
    } as unknown as typeof ServerSettingsService.Service,
    opencodeServerManager: {} as typeof OpencodeServerManager.Service,
  });
  return { http, service, router };
}

describe("all six V2 internal-generation operations", () => {
  it.each(INTERNAL_TEXT_GENERATION_OPERATIONS)(
    "%s routes exact native account/model/variant without legacy or chat writes",
    async (operation) => {
      const { http, router } = fixture();
      const result = await Effect.runPromise<unknown, TextGenerationError>(
        router[operation](input),
      );
      expect(result).toMatchObject({ actualModelSelection: textGenerationSelection });
      const generated = http.requests.find(({ pathname }) => pathname.endsWith("/generate"))!;
      expect(generated.body.prompt).toContain("Return only a JSON object matching this schema:");
      if (operation === "generateCommitMessage")
        expect(generated.body.prompt).toContain("CUSTOM COMMIT INSTRUCTIONS");
      expect(
        http.requests.filter(
          ({ pathname, method }) => pathname === "/api/session" && method === "POST",
        ),
      ).toHaveLength(1);
      expect(http.sessions.size).toBe(0);
    },
  );
  it("retains existing commit/branch/title/summary normalization", async () => {
    const { service } = fixture();
    expect(await Effect.runPromise(service.generateCommitMessage(input))).toEqual({
      subject: output.subject,
      body: output.body,
      branch: `feature/${output.branch}`,
    });
    expect(await Effect.runPromise(service.generatePrContent(input))).toEqual({
      title: output.title,
      body: output.body,
    });
    expect(await Effect.runPromise(service.generateBranchName(input))).toEqual({
      branch: output.branch,
    });
    expect(await Effect.runPromise(service.generateThreadTitle(input))).toEqual({
      title: output.title,
    });
    expect(await Effect.runPromise(service.generateThreadElevatorSummary(input))).toEqual({
      summary: output.summary,
    });
    expect(await Effect.runPromise(service.generatePromptSuggestion(input))).toEqual({
      suggestion: output.suggestion,
    });
  });
  it.each(["not JSON", '{"title":13}', "{}"])(
    "rejects malformed native structured output: %s",
    async (text) => {
      const { http, service } = fixture();
      http.options.text = text;
      const error = await Effect.runPromise(service.generateThreadTitle(input).pipe(Effect.flip));
      expect(error.detail).toBe("OpenCode v2 returned invalid structured output.");
      expect(error.cause).toBeUndefined();
      expect(http.sessions.size).toBe(0);
    },
  );
  it("sanitizes native errors and classifies cancellation without paid fallback", async () => {
    for (const cancelled of [false, true]) {
      const run = makeV2StructuredTextRunner(async () => {
        if (cancelled) throw new DOMException("private token prompt", "AbortError");
        throw new Error("private token prompt");
      });
      const error = await Effect.runPromise(
        run({
          operation: "generateThreadTitle",
          cwd: "/fixture",
          prompt: "private transcript",
          modelSelection: textGenerationSelection,
          outputSchema: Schema.Struct({ title: Schema.String }),
        }).pipe(Effect.flip),
      );
      expect(error).toBeInstanceOf(TextGenerationError);
      expect(error.kind).toBe(cancelled ? "cancelled" : "provider");
      expect(JSON.stringify(error)).not.toMatch(/private|token|transcript/);
    }
  });
});
