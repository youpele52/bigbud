import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import { describe, expect, it } from "vitest";

import type { GitCoreShape } from "../Services/GitCore.ts";
import type {
  CommitMessageGenerationInput,
  TextGenerationShape,
} from "../Services/TextGeneration.ts";
import { makeCommitStep } from "./GitManager.commitStep.ts";

describe("GitManager commit step", () => {
  it("uses the local server cwd for remote commit-message generation", async () => {
    let generationInput: CommitMessageGenerationInput | undefined;
    const gitCore = {
      prepareCommitContext: (
        cwd: string,
        filePaths?: readonly string[],
        executionTargetId?: string,
      ) => {
        expect({ cwd, filePaths, executionTargetId }).toEqual({
          cwd: "/srv/remote-project",
          filePaths: undefined,
          executionTargetId: "ssh:example",
        });
        return Effect.succeed({
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
        });
      },
    } as unknown as GitCoreShape;
    const textGeneration = {
      generateCommitMessage: (input: CommitMessageGenerationInput) => {
        generationInput = input;
        return Effect.succeed({ subject: "Update README", body: "" });
      },
    } as unknown as TextGenerationShape;

    const suggestion = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        return yield* makeCommitStep(
          gitCore,
          textGeneration,
          fileSystem,
          "/local/server-root",
        ).resolveCommitAndBranchSuggestion({
          cwd: "/srv/remote-project",
          branch: "main",
          executionTargetId: "ssh:example",
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet-5" },
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(generationInput?.cwd).toBe("/local/server-root");
    expect(suggestion?.subject).toBe("Update README");
  });
});
