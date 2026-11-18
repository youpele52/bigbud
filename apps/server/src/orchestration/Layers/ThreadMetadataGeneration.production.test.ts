import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts/core/baseSchemas.ts";
import { TextGenerationError } from "@bigbud/contracts/workspace/git.errors.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import type {
  MetadataTextGenerationAttempt,
  TextGenerationShape,
} from "../../git/Services/TextGeneration.ts";
import { makeThreadMetadataGenerationRepository } from "../../persistence/Layers/ThreadMetadataGeneration.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import {
  createCommands,
  createRuntime,
  engineFor,
  withDatabase,
} from "./OrchestrationEngine.test.runtime.ts";
import { capturedTitle } from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";
import { makeThreadMetadataGeneration } from "./ThreadMetadataGeneration.ts";
import type { MetadataExecutionIdentity } from "./ThreadMetadataGeneration.executionIdentity.ts";

/** Same service factory as the reactor, with only external provider authority replaced. */
describe("production metadata composition", () => {
  it.each(
    (["title", "summary"] as const).flatMap((operation) =>
      (
        [
          "stepped",
          "scheduler-restart",
          "uncertain-restart",
          "metadata-edit",
          "thread-failure",
        ] as const
      ).map((mode) => ({ operation, mode })),
    ),
  )("recovers $operation through $mode without duplicate paid work", ({ operation, mode }) =>
    withDatabase("bigbud-metadata-production-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const engine = await engineFor(runtime);
        const threadId = ThreadId.makeUnsafe(`production-${operation}`);
        for (const command of createCommands(ProjectId.makeUnsafe("production"), [threadId])) {
          await runtime.runPromise(
            engine.dispatch(
              command.type === "thread.create"
                ? { ...command, title: "New thread" }
                : command.type === "project.create"
                  ? { ...command, workspaceRoot: "/tmp" }
                  : command,
            ),
          );
        }
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("first-user"),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe("first-user"),
              role: "user",
              text: "Repair durable metadata recovery",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: new Date().toISOString(),
          }),
        );
        for (let index = 0; index < 4; index++) {
          await runtime.runPromise(
            engine.dispatch({
              type: "thread.message.assistant.complete",
              commandId: CommandId.makeUnsafe(`assistant-${index}`),
              threadId,
              messageId: MessageId.makeUnsafe(`assistant-${index}`),
              text: `Progress ${index}`,
              createdAt: new Date().toISOString(),
            }),
          );
        }
        await runtime.runPromise(
          engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe("verified-model"),
            threadId,
            createdAt: new Date().toISOString(),
            activity: {
              id: EventId.makeUnsafe("verified-model"),
              kind: "text-generation.model-succeeded",
              tone: "info",
              turnId: null,
              summary: "Verified model",
              payload: { provider: "codex", model: "thread-model" },
              createdAt: new Date().toISOString(),
            },
          }),
        );
        await runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const settings = yield* ServerSettingsService;
              yield* settings.updateSettings({
                textGenerationModelSelection: { provider: "codex", model: "configured-model" },
              });
              const calls: string[] = [];
              const generate = Effect.fn("productionTest.generate")(function* (
                attempt: MetadataTextGenerationAttempt | undefined,
              ) {
                if (!attempt) return yield* Effect.die("Exact attempt missing");
                yield* attempt.beforeDispatch();
                calls.push(attempt.selection.model);
                if (mode === "uncertain-restart")
                  return yield* new TextGenerationError({
                    operation: "metadata",
                    detail: "Dispatch acknowledgment was lost",
                    metadataOutcome: "uncertain",
                  });
                if (attempt.selection.model === "configured-model" || mode === "thread-failure")
                  return yield* new TextGenerationError({
                    operation:
                      operation === "title"
                        ? "generateThreadTitle"
                        : "generateThreadElevatorSummary",
                    detail: "Completed invalid output",
                    metadataOutcome: "failed",
                  });
                if (mode === "metadata-edit")
                  yield* engine
                    .dispatch({
                      type: "thread.meta.update",
                      commandId: CommandId.makeUnsafe("concurrent-metadata-edit"),
                      threadId,
                      ...(operation === "title"
                        ? { title: "Keep the concurrent edit" }
                        : { elevatorSummary: "Keep the concurrent edit" }),
                    })
                    .pipe(Effect.orDie);
                return "Repair durable metadata recovery";
              });
              const unexpected = () => Effect.die("Unrelated generation path invoked");
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
                  Effect.succeed({ ...capturedTitle().primaryPath!, selection, executionTarget }),
                providerSettings: () =>
                  settings.getSettings.pipe(
                    Effect.map((value) => value.providers),
                    Effect.orDie,
                  ),
                withExecutionIdentity: (_context, _path, _snapshot, claim) => claim,
              };
              let time = Date.now();
              const now = () => new Date(time).toISOString();
              const compose = () =>
                makeThreadMetadataGeneration({
                  engine,
                  settings,
                  textGeneration,
                  executionIdentity,
                  now,
                });
              const service = yield* compose();
              const before = (yield* engine.ensureThreadState!(threadId, "history"))!;
              const repository = yield* makeThreadMetadataGenerationRepository();
              const request =
                operation === "title"
                  ? service.title({ threadId, messageText: "Repair durable metadata recovery" })
                  : service.summary({ threadId });
              yield* request;
              const initial = yield* repository.listDue({ at: now(), limit: 100 });
              expect(initial).toHaveLength(1);
              const job = initial[0]!;
              // Duplicate reactor delivery coalesces before provider work.
              yield* request;
              expect(yield* repository.listDue({ at: now(), limit: 100 })).toHaveLength(1);
              yield* service.step(job.jobId);
              time += 30_000;
              // Recompose from durable state: neither the paid budget nor uncertain
              // ownership belongs to a process-local coordinator instance.
              const resumed = mode.endsWith("restart") ? yield* compose() : service;
              if (mode === "scheduler-restart") {
                yield* Effect.scoped(
                  Effect.gen(function* () {
                    yield* resumed.start();
                    yield* resumed.start();
                    for (let tick = 0; tick < 600; tick++) {
                      const current = Option.getOrThrow(yield* repository.get(job.jobId));
                      if (current.state === "completed") return;
                      // Advance backoff without expiring the entire 30-minute job
                      // before the real scheduler's two-second poll.
                      time += 100;
                      yield* Effect.sleep("20 millis");
                    }
                    return yield* Effect.die("Metadata scheduler did not settle");
                  }),
                );
              } else {
                for (let step = 0; step < 12; step++) {
                  yield* resumed.step(job.jobId);
                  time += 30_000;
                }
              }
              if (mode === "uncertain-restart") {
                expect(calls).toEqual(["configured-model"]);
                // The immutable attempt, not the scheduler's job hint, fences replay.
                expect(
                  (yield* repository.listAttempts(job.jobId)).map((attempt) => attempt.state),
                ).toEqual(["uncertain"]);
                yield* request;
                yield* resumed.step(job.jobId);
                expect(calls).toHaveLength(1);
                expect(yield* repository.listPendingWarnings(100)).toHaveLength(0);
                return;
              }
              expect(calls).toEqual(["configured-model", "configured-model", "thread-model"]);
              const retained = Option.getOrThrow(yield* repository.get(job.jobId));
              if (mode === "thread-failure") {
                expect(retained.state).toBe("exhausted");
                expect((yield* repository.listAttempts(job.jobId)).map((a) => a.state)).toEqual([
                  "failed",
                  "failed",
                  "failed",
                ]);
                expect(yield* repository.listPendingWarnings(100)).toHaveLength(2);
                const after = (yield* engine.ensureThreadState!(threadId, "history"))!;
                expect(after.title).toBe(before.title);
                expect(after.elevatorSummary).toBe(before.elevatorSummary);
                yield* request;
                yield* resumed.step(job.jobId);
                expect(calls).toHaveLength(3);
                return;
              }
              expect(retained.state).toBe(mode === "metadata-edit" ? "stale" : "completed");
              expect(yield* repository.listPendingWarnings(100)).toHaveLength(1);
              const attempts = yield* repository.listAttempts(job.jobId);
              expect(attempts.map((attempt) => attempt.state)).toEqual([
                "failed",
                "failed",
                mode === "metadata-edit" ? "stale" : "completed",
              ]);
              const thread = (yield* engine.ensureThreadState!(threadId, "history"))!;
              expect(operation === "title" ? thread.title : thread.elevatorSummary).toBe(
                mode === "metadata-edit"
                  ? "Keep the concurrent edit"
                  : "Repair durable metadata recovery",
              );
              yield* request;
              expect(calls).toHaveLength(3);
            }),
          ),
        );
      } finally {
        await runtime.dispose();
      }
    }),
  );
});
