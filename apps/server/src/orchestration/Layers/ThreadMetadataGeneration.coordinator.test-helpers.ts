import { randomUUID } from "node:crypto";
import { ThreadId, ProjectId } from "@bigbud/contracts/core/baseSchemas";
import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/core/settings.ts";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type {
  MetadataTextGenerationAttempt,
  TextGenerationShape,
} from "../../git/Services/TextGeneration.ts";
import { ThreadMetadataGenerationRepositoryLive } from "../../persistence/Layers/ThreadMetadataGeneration.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ThreadMetadataGenerationRepositoryShape } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import type {
  MetadataCapturedContext,
  MetadataCapturedPath,
  MetadataTitleContext,
} from "./ThreadMetadataGeneration.context.ts";
import {
  MetadataCoordinatorError,
  type MetadataCoordinatorHost,
} from "./ThreadMetadataGeneration.coordinator.types.ts";
import { makeMetadataCoordinator } from "./ThreadMetadataGeneration.coordinator.ts";
import { makeMetadataJobInput } from "./ThreadMetadataGeneration.jobs.ts";

export const coordinatorTestLayer = ThreadMetadataGenerationRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
export const initialTime = "2026-11-09T10:00:00.000Z";
export const capturedTitle = (): MetadataTitleContext => ({
  version: 1,
  threadId: ThreadId.makeUnsafe("coordinator"),
  operation: "title",
  expectedRevision: 0,
  configEpoch: "epoch-1",
  configuredPrimary: true,
  primaryPath: {
    selection: { provider: "codex", model: "configured", options: { reasoningEffort: "high" } },
    transport: "codex-cli",
    accountIdentity: "opaque-account",
    executionTarget: "local",
    promptVersion: "title-v1",
    validatorVersion: "title-v1",
    mode: "auxiliary",
  },
  threadPath: {
    selection: { provider: "codex", model: "verified-thread" },
    transport: "codex-cli",
    accountIdentity: "opaque-account",
    executionTarget: "local",
    promptVersion: "title-v1",
    validatorVersion: "title-v1",
    mode: "auxiliary",
  },
  workspace: {
    projectId: ProjectId.makeUnsafe("project"),
    worktreePath: null,
    branch: null,
    executionTarget: "local",
    cwd: "/workspace",
  },
  source: { prefixLength: 1, frontier: 1, digest: "captured-prefix" },
  initialTitle: "New thread",
  titleSeed: "New thread",
  message: "Repair durable metadata recovery",
  attachments: [],
});

export function makeCoordinatorFixture(repository: ThreadMetadataGenerationRepositoryShape) {
  const threadId = ThreadId.makeUnsafe(`coordinator-${randomUUID()}`);
  const control = {
    at: initialTime,
    outcome: "failed" as
      | "failed"
      | "uncertain"
      | "cancelled"
      | "unavailable"
      | "success"
      | "defect",
    current: true,
    settingsAvailable: true,
    commitFails: false,
    verifiedPath: null as MetadataCapturedPath | null,
    calls: [] as string[],
    commits: [] as string[],
  };
  const error = (operation: "generateThreadTitle" | "generateThreadElevatorSummary") =>
    new TextGenerationError({
      operation,
      detail: "Private provider failure",
      metadataOutcome:
        control.outcome === "unavailable"
          ? "unavailable"
          : control.outcome === "cancelled"
            ? "cancelled"
            : control.outcome === "failed"
              ? "failed"
              : "uncertain",
    });
  const generate = Effect.fn("fixture.generate")(function* (
    attempt: MetadataTextGenerationAttempt | undefined,
    operation: "generateThreadTitle" | "generateThreadElevatorSummary",
  ) {
    if (!attempt) return yield* Effect.die("Expected exact metadata dispatch");
    if (control.outcome === "unavailable") return yield* error(operation);
    yield* attempt.beforeDispatch();
    control.calls.push(attempt.selection.model);
    if (control.outcome === "defect") return yield* Effect.die("Interrupted after dispatch intent");
    if (control.outcome !== "success") return yield* error(operation);
    return "Repair durable metadata recovery";
  });
  const unexpected = () => Effect.die("Unrelated generation must not be called");
  const textGeneration: TextGenerationShape = {
    generateCommitMessage: unexpected,
    generatePrContent: unexpected,
    generateBranchName: unexpected,
    generatePromptSuggestion: unexpected,
    generateThreadTitle: (input) =>
      generate(input.metadataAttempt, "generateThreadTitle").pipe(
        Effect.map((title) => ({ title })),
      ),
    generateThreadElevatorSummary: (input) =>
      generate(input.metadataAttempt, "generateThreadElevatorSummary").pipe(
        Effect.map((summary) => ({ summary })),
      ),
  };
  const host: MetadataCoordinatorHost = {
    now: () => control.at,
    isCurrent: () => Effect.succeed(control.current),
    captureVerifiedThreadPath: () => Effect.succeed(control.verifiedPath),
    providerSettings: () =>
      Effect.succeed(
        control.settingsAvailable ? structuredClone(DEFAULT_SERVER_SETTINGS.providers) : null,
      ),
    withDispatchAdmission: (_context, _path, claim) => claim,
    commitResult: Effect.fn("fixture.commitResult")(function* (job, attempt) {
      control.commits.push(attempt.result!);
      if (control.commitFails)
        return yield* new MetadataCoordinatorError({
          detail: "Simulated canonical transaction failure.",
        });
      // Test-only settlement; production must also atomically write canonical event/projection/receipt.
      yield* repository.settleAttempt({ attempt, state: "completed", at: control.at });
      yield* repository.transitionJob({
        jobId: job.jobId,
        expectedRevision: job.revision,
        state: "completed",
        nextAttemptAt: control.at,
      });
    }),
  };
  const coordinator = makeMetadataCoordinator({ repository, textGeneration, host });
  const create = (context: MetadataCapturedContext = capturedTitle()) =>
    repository.createOrGet(
      makeMetadataJobInput({
        context: { ...context, threadId },
        generationKey: "initial",
        at: initialTime,
      }),
    );
  const advance = (ms: number) => {
    control.at = new Date(Date.parse(control.at) + ms).toISOString();
  };
  return { control, coordinator, create, advance, host, textGeneration };
}
