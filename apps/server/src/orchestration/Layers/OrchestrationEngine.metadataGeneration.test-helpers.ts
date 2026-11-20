import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect } from "vitest";

import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { makeMetadataConfiguration } from "./ThreadMetadataGeneration.configuration.ts";
import { makeThreadMetadataGenerationRepository } from "../../persistence/Layers/ThreadMetadataGeneration.ts";
import { capturedTitle, initialTime } from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";
import {
  makeMetadataResultCommand,
  metadataAttemptId,
  metadataCommandId,
  metadataCommitIdentity,
} from "./ThreadMetadataGeneration.identity.ts";
import { makeMetadataJobInput } from "./ThreadMetadataGeneration.jobs.ts";
import { metadataExecutionFingerprint } from "./ThreadMetadataGeneration.policy.ts";
import { metadataTitleAdapter } from "./ThreadMetadataGeneration.title.ts";
import { metadataSummaryAdapter } from "./ThreadMetadataGeneration.summary.ts";
import { loadMetadataContext } from "./ThreadMetadataGeneration.modelBinding.ts";
import { createCommands, createRuntime, engineFor } from "./OrchestrationEngine.test.runtime.ts";

export const threadId = ThreadId.makeUnsafe("metadata-atomic");
type Runtime = ReturnType<typeof createRuntime>;
export const setupMetadataThread = async (
  runtime: Runtime,
  operation: "title" | "summary" = "title",
  lateModel = false,
) => {
  const engine = await engineFor(runtime);
  for (const command of createCommands(ProjectId.makeUnsafe("metadata-project"), [threadId])) {
    await runtime.runPromise(
      engine.dispatch(
        command.type === "project.create"
          ? { ...command, workspaceRoot: "/tmp" }
          : command.type === "thread.create"
            ? { ...command, title: "New thread" }
            : command,
      ),
    );
  }
  await runtime.runPromise(
    engine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: CommandId.makeUnsafe("source"),
      threadId,
      messageId: MessageId.makeUnsafe("source"),
      text: "Repair atomic metadata persistence",
      createdAt: initialTime,
    }),
  );
  const repository = await runtime.runPromise(makeThreadMetadataGenerationRepository());
  const thread = (await runtime.runPromise(engine.getReadModel())).threads.find(
    (t) => t.id === threadId,
  )!;
  const configEpoch = await runtime.runPromise(
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const configuration = yield* makeMetadataConfiguration(settings);
      return yield* settings.withSnapshotBarrier!(configuration.epochFor);
    }),
  );
  const options = {
    ...capturedTitle(),
    configEpoch,
    cwd: "/tmp",
    ...(lateModel ? { configuredPrimary: false, primaryPath: null, threadPath: null } : {}),
  };
  let context =
    operation === "title"
      ? metadataTitleAdapter.capture(thread, {
          ...options,
          message: "Repair atomic metadata persistence",
        })!
      : metadataSummaryAdapter.capture(thread, { ...options, attemptedFrontier: 0, force: true })!;
  let job = await runtime.runPromise(
    repository.createOrGet(
      makeMetadataJobInput({
        context,
        generationKey: "initial",
        at: initialTime,
      }),
    ),
  );
  if (lateModel) {
    const path = capturedTitle().threadPath!;
    const verifiedModelJson = JSON.stringify(path.selection);
    await runtime.runPromise(repository.recordSuccessfulModel(threadId, verifiedModelJson));
    expect(
      await runtime.runPromise(
        repository.bindThreadModel({
          job,
          pathJson: JSON.stringify(path),
          verifiedModelJson,
          at: initialTime,
        }),
      ),
    ).toBe(true);
    job = Option.getOrThrow(await runtime.runPromise(repository.get(job.jobId)));
    context = await runtime.runPromise(loadMetadataContext(repository, job));
  }
  return { engine, repository, job, context, originalThread: thread };
};

export const setup = async (
  runtime: Runtime,
  operation: "title" | "summary" = "title",
  lateModel = false,
) => {
  const base = await setupMetadataThread(runtime, operation, lateModel);
  const { repository, job, context } = base;
  const stage = lateModel ? "thread-model" : "primary";
  const path = lateModel ? context.threadPath! : context.primaryPath!;
  const attemptId = metadataAttemptId(job.jobId, stage, 1);
  const prepared = Option.getOrThrow(
    await runtime.runPromise(
      repository.prepareAttempt({
        job,
        attempt: {
          attemptId,
          jobId: job.jobId,
          threadId,
          stage,
          ordinal: 1,
          owner: "original-owner",
          executionFingerprint: metadataExecutionFingerprint(path),
          payloadJson: JSON.stringify({
            version: 1,
            commandId: metadataCommandId(operation, attemptId),
            createdAt: initialTime,
            path,
          }),
          providerSessionId: null,
          providerTurnId: null,
          sessionEpoch: null,
          createdAt: initialTime,
          updatedAt: initialTime,
        },
      }),
    ),
  );
  expect(await runtime.runPromise(repository.claimDispatch(prepared, initialTime))).toBe(true);
  const sent = (await runtime.runPromise(repository.listAttempts(job.jobId)))[0]!;
  expect(
    await runtime.runPromise(
      repository.settleAttempt({
        attempt: sent,
        state: "result-ready",
        result: "Repair atomic metadata persistence",
        at: initialTime,
      }),
    ),
  ).toBe(true);
  const attempt = (await runtime.runPromise(repository.listAttempts(job.jobId)))[0]!;
  const command = await runtime.runPromise(makeMetadataResultCommand(job, attempt, context));
  return {
    ...base,
    attempt,
    command,
    options: { metadataCommit: metadataCommitIdentity(job, attempt) },
  };
};

export const readRows = (commandId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      status: string;
    }>`SELECT status FROM orchestration_command_receipts WHERE command_id = ${commandId}`;
  });
