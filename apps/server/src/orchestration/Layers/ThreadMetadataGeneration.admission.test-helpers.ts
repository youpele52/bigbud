import { CommandId, MessageId, ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { makeThreadMetadataGenerationRepository } from "../../persistence/Layers/ThreadMetadataGeneration.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { makeMetadataConfiguration } from "./ThreadMetadataGeneration.configuration.ts";
import { makeMetadataDispatchAdmission } from "./ThreadMetadataGeneration.admission.ts";
import { capturedTitle, initialTime } from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";
import { metadataAttemptId, metadataCommandId } from "./ThreadMetadataGeneration.identity.ts";
import { makeMetadataJobInput } from "./ThreadMetadataGeneration.jobs.ts";
import { metadataExecutionFingerprint } from "./ThreadMetadataGeneration.policy.ts";
import { metadataTitleAdapter } from "./ThreadMetadataGeneration.title.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";

export async function makeAdmissionFixture(runtime: ReturnType<typeof createRuntime>) {
  const threadId = ThreadId.makeUnsafe("metadata-admission");
  const engine = await engineFor(runtime);
  for (const command of createCommands(ProjectId.makeUnsafe("admission-project"), [threadId])) {
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
      text: "Repair durable metadata recovery",
      createdAt: initialTime,
    }),
  );
  const repository = await runtime.runPromise(makeThreadMetadataGenerationRepository());
  const settings = await runtime.runPromise(Effect.service(ServerSettingsService));
  const thread = (await runtime.runPromise(engine.getReadModel())).threads.find(
    (t) => t.id === threadId,
  )!;
  const configuration = await runtime.runPromise(makeMetadataConfiguration(settings));
  const configEpoch = await runtime.runPromise(
    settings.withSnapshotBarrier!(configuration.epochFor),
  );
  const context = metadataTitleAdapter.capture(thread, {
    ...capturedTitle(),
    configEpoch,
    cwd: "/tmp",
    message: thread.messages[0]!.text,
  })!;
  const job = await runtime.runPromise(
    repository.createOrGet(
      makeMetadataJobInput({
        context,
        generationKey: "initial",
        at: initialTime,
      }),
    ),
  );
  const attemptId = metadataAttemptId(job.jobId, "primary", 1);
  const attempt = Option.getOrThrow(
    await runtime.runPromise(
      repository.prepareAttempt({
        job,
        attempt: {
          attemptId,
          jobId: job.jobId,
          threadId,
          stage: "primary",
          ordinal: 1,
          owner: "original-owner",
          executionFingerprint: metadataExecutionFingerprint(context.primaryPath!),
          payloadJson: JSON.stringify({
            version: 1,
            commandId: metadataCommandId("title", attemptId),
            createdAt: initialTime,
            path: context.primaryPath,
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
  // Test-only authority: production must prove the actual provider/account identity.
  const input = {
    engine,
    settings,
    withExecutionIdentity: (_context, _path, _snapshot, claim) => claim,
  } satisfies Parameters<typeof makeMetadataDispatchAdmission>[0];
  const admit = await runtime.runPromise(makeMetadataDispatchAdmission(input));
  const claim = repository.claimDispatch(attempt, initialTime).pipe(Effect.asVoid);
  return {
    runtime,
    engine,
    settings,
    repository,
    threadId,
    context,
    job,
    attempt,
    input,
    admit,
    claim,
  };
}

export type AdmissionFixture = Awaited<ReturnType<typeof makeAdmissionFixture>>;
export async function withAdmissionFixture(run: (fixture: AdmissionFixture) => Promise<void>) {
  await withDatabase("bigbud-metadata-admission-", async (dbPath) => {
    const runtime = createRuntime(dbPath);
    try {
      await run(await makeAdmissionFixture(runtime));
    } finally {
      await runtime.dispose();
    }
  });
}
