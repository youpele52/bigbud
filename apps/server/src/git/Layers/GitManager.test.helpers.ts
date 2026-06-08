import * as NodeServices from "@effect/platform-node/NodeServices";
import type { GitPreparePullRequestThreadInput, ModelSelection, ThreadId } from "@bigbud/contracts";
import { TextGenerationError } from "@bigbud/contracts";
import { Effect, Layer } from "effect";

import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerShape,
} from "../../project/Services/ProjectSetupScriptRunner.ts";
import { ServerConfig } from "../../startup/config.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import type { GitManagerShape } from "../Services/GitManager.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import { GitCoreLive } from "./GitCore.ts";
import { createGitHubCliWithFakeGh, type FakeGhScenario } from "./GitManager.test.fakeGh.ts";
import { makeGitManager } from "./GitManager.ts";

export interface FakeGitTextGeneration {
  generateCommitMessage: (input: {
    cwd: string;
    branch: string | null;
    stagedSummary: string;
    stagedPatch: string;
    includeBranch?: boolean;
    modelSelection: ModelSelection;
  }) => Effect.Effect<
    { subject: string; body: string; branch?: string | undefined },
    TextGenerationError
  >;
  generatePrContent: (input: {
    cwd: string;
    baseBranch: string;
    headBranch: string;
    commitSummary: string;
    diffSummary: string;
    diffPatch: string;
    modelSelection: ModelSelection;
  }) => Effect.Effect<{ title: string; body: string }, TextGenerationError>;
  generateBranchName: (input: {
    cwd: string;
    message: string;
    modelSelection: ModelSelection;
  }) => Effect.Effect<{ branch: string }, TextGenerationError>;
  generateThreadTitle: (input: {
    cwd: string;
    message: string;
    modelSelection: ModelSelection;
  }) => Effect.Effect<{ title: string }, TextGenerationError>;
}

function createTextGeneration(overrides: Partial<FakeGitTextGeneration> = {}): TextGenerationShape {
  const implementation: FakeGitTextGeneration = {
    generateCommitMessage: (input) =>
      Effect.succeed({
        subject: "Implement stacked git actions",
        body: "",
        ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
      }),
    generatePrContent: () =>
      Effect.succeed({
        title: "Add stacked git actions",
        body: "## Summary\n- Add stacked git workflow\n\n## Testing\n- Not run",
      }),
    generateBranchName: () =>
      Effect.succeed({
        branch: "update-workflow",
      }),
    generateThreadTitle: () =>
      Effect.succeed({
        title: "Update workflow",
      }),
    ...overrides,
  };

  return {
    generateCommitMessage: (input) =>
      implementation.generateCommitMessage(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generatePrContent: (input) =>
      implementation.generatePrContent(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generatePrContent",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateBranchName: (input) =>
      implementation.generateBranchName(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateThreadTitle: (input) =>
      implementation.generateThreadTitle(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
  };
}

export function runStackedAction(
  manager: GitManagerShape,
  input: {
    cwd: string;
    action: "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr";
    actionId?: string;
    commitMessage?: string;
    featureBranch?: boolean;
    filePaths?: readonly string[];
  },
  options?: Parameters<GitManagerShape["runStackedAction"]>[1],
) {
  return manager.runStackedAction(
    {
      ...input,
      actionId: input.actionId ?? "test-action-id",
    },
    options,
  );
}

export function resolvePullRequest(
  manager: GitManagerShape,
  input: { cwd: string; reference: string },
) {
  return manager.resolvePullRequest(input);
}

export function preparePullRequestThread(
  manager: GitManagerShape,
  input: GitPreparePullRequestThreadInput,
) {
  return manager.preparePullRequestThread(input);
}

export function makeManager(input?: {
  ghScenario?: FakeGhScenario;
  textGeneration?: Partial<FakeGitTextGeneration>;
  setupScriptRunner?: ProjectSetupScriptRunnerShape;
}) {
  const { service: gitHubCli, ghCalls } = createGitHubCliWithFakeGh(input?.ghScenario);
  const textGeneration = createTextGeneration(input?.textGeneration);
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-git-manager-test-",
  });

  const serverSettingsLayer = ServerSettingsService.layerTest();

  const gitCoreLayer = GitCoreLive.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerConfigLayer),
  );

  const managerLayer = Layer.mergeAll(
    Layer.succeed(GitHubCli, gitHubCli),
    Layer.succeed(TextGeneration, textGeneration),
    Layer.succeed(
      ProjectSetupScriptRunner,
      input?.setupScriptRunner ?? {
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      },
    ),
    gitCoreLayer,
    serverSettingsLayer,
  ).pipe(Layer.provideMerge(NodeServices.layer));

  return makeGitManager().pipe(
    Effect.provide(managerLayer),
    Effect.map((manager) => ({ manager, ghCalls })),
  );
}

export const asThreadId = (threadId: string) => threadId as ThreadId;

export const GitManagerTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-manager-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
