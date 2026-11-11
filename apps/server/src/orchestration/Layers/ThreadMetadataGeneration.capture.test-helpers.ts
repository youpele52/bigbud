import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  MetadataTextGenerationAttempt,
  TextGenerationShape,
} from "../../git/Services/TextGeneration.ts";
import { makeThreadMetadataGenerationRepository } from "../../persistence/Layers/ThreadMetadataGeneration.ts";
import type { MetadataGenerationJob } from "../../persistence/Services/ThreadMetadataGeneration.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";
import { capturedTitle } from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";
import type { MetadataExecutionIdentity } from "./ThreadMetadataGeneration.executionIdentity.ts";
import { makeThreadMetadataGeneration } from "./ThreadMetadataGeneration.ts";

export const captureThreadId = ThreadId.makeUnsafe("capture-lifecycle");
export const makeCaptureFixture = Effect.fn("makeCaptureFixture")(function* (
  engine: OrchestrationEngineShape,
  operation: "title" | "summary",
) {
  for (const command of createCommands(ProjectId.makeUnsafe("capture-project"), [captureThreadId]))
    yield* engine.dispatch(
      command.type === "project.create"
        ? { ...command, workspaceRoot: "/tmp" }
        : command.type === "thread.create"
          ? { ...command, title: "New thread" }
          : command,
    );
  yield* engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.makeUnsafe("capture-first-user"),
    threadId: captureThreadId,
    message: {
      messageId: MessageId.makeUnsafe("first-user"),
      role: "user",
      text: "Repair durable capture lifecycle",
      attachments: [],
    },
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  for (let index = 0; index < 4; index++)
    yield* engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: CommandId.makeUnsafe(`capture-assistant-${index}`),
      threadId: captureThreadId,
      messageId: MessageId.makeUnsafe(`assistant-${index}`),
      text: `Progress ${index}`,
      createdAt: new Date().toISOString(),
    });
  const settings = yield* ServerSettingsService;
  yield* settings.updateSettings({
    textGenerationModelSelection: { provider: "codex", model: "model-a" },
  });
  const control = {
    time: Date.now(),
    calls: [] as string[],
    captures: 0,
    outcome: "success" as "success" | "failed" | "uncertain",
  };
  const now = () => new Date(control.time).toISOString();
  const generate = Effect.fn("captureFixture.generate")(function* (
    attempt: MetadataTextGenerationAttempt | undefined,
  ) {
    if (!attempt) return yield* Effect.die("Missing exact metadata attempt");
    yield* attempt.beforeDispatch();
    control.calls.push(attempt.selection.model);
    if (control.outcome !== "success")
      return yield* new TextGenerationError({
        operation: "metadata",
        detail: "Fixture provider outcome",
        metadataOutcome: control.outcome,
      });
    return "Repair durable capture lifecycle";
  });
  const unexpected = () => Effect.die("Unrelated generation invoked");
  const textGeneration: TextGenerationShape = {
    generateCommitMessage: unexpected,
    generatePrContent: unexpected,
    generateBranchName: unexpected,
    generatePromptSuggestion: unexpected,
    generateThreadTitle: (input) =>
      generate(input.metadataAttempt).pipe(Effect.map((title) => ({ title }))),
    generateThreadElevatorSummary: (input) =>
      generate(input.metadataAttempt).pipe(Effect.map((summary) => ({ summary }))),
  };
  const executionIdentity: MetadataExecutionIdentity = {
    capture: (selection, executionTarget) =>
      Effect.sync(() => {
        control.captures++;
        return { ...capturedTitle().primaryPath!, selection, executionTarget };
      }),
    providerSettings: () =>
      settings.getSettings.pipe(
        Effect.map((value) => value.providers),
        Effect.orDie,
      ),
    withExecutionIdentity: (_context, _path, _snapshot, claim) => claim,
  };
  const compose = () =>
    makeThreadMetadataGeneration({ engine, settings, textGeneration, executionIdentity, now });
  const service = yield* compose();
  const repository = yield* makeThreadMetadataGenerationRepository();
  const request = (retryKey?: string) =>
    operation === "title"
      ? service.title({
          threadId: captureThreadId,
          messageText: "Repair durable capture lifecycle",
          ...(retryKey === undefined ? {} : { retryKey }),
        })
      : service.summary({
          threadId: captureThreadId,
          force: true,
          ...(retryKey === undefined ? {} : { retryKey }),
        });
  const open = repository.findOpen(captureThreadId, operation).pipe(Effect.map(Option.getOrThrow));
  const read = (jobId: string) => repository.get(jobId).pipe(Effect.map(Option.getOrThrow));
  const jobs = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      jobId: string;
      state: string;
    }>`SELECT job_id AS "jobId", state FROM thread_metadata_generation_jobs WHERE thread_id = ${captureThreadId} AND operation = ${operation}`;
  });
  const branch = (name: string) =>
    engine.dispatch({
      type: "thread.meta.update",
      commandId: CommandId.makeUnsafe(`branch-${name}`),
      threadId: captureThreadId,
      branch: name,
    });
  const prepare = (job: MetadataGenerationJob) =>
    repository
      .prepareAttempt({
        job,
        attempt: {
          attemptId: `${job.jobId}:test-prepared`,
          jobId: job.jobId,
          threadId: captureThreadId,
          stage: "primary",
          ordinal: 1,
          owner: "capture-test",
          executionFingerprint: "captured-path",
          payloadJson: "{}",
          providerSessionId: null,
          providerTurnId: null,
          sessionEpoch: null,
          createdAt: now(),
          updatedAt: now(),
        },
      })
      .pipe(Effect.map(Option.getOrThrow));
  return {
    engine,
    settings,
    service,
    compose,
    repository,
    request,
    open,
    read,
    jobs,
    branch,
    prepare,
    control,
    now,
  };
});

type CaptureFixture = Effect.Success<ReturnType<typeof makeCaptureFixture>>;
export function captureLifecycleTest<E>(
  operation: "title" | "summary",
  run: (
    fixture: CaptureFixture,
  ) => Effect.Effect<
    void,
    E,
    | SqlClient.SqlClient
    | Scope.Scope
    | FileSystem.FileSystem
    | ChildProcessSpawner.ChildProcessSpawner
  >,
) {
  return withDatabase("bigbud-capture-lifecycle-", async (dbPath) => {
    const runtime = createRuntime(dbPath);
    try {
      const engine = await engineFor(runtime);
      await runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* run(yield* makeCaptureFixture(engine, operation));
          }),
        ),
      );
    } finally {
      await runtime.dispose();
    }
  });
}
