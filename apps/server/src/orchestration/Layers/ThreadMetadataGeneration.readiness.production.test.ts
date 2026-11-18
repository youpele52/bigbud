import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import type {
  MetadataTextGenerationAttempt,
  TextGenerationShape,
} from "../../git/Services/TextGeneration.ts";
import { makeThreadMetadataGenerationRepository } from "../../persistence/Layers/ThreadMetadataGeneration.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../../ws/serverSettings.ts";
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

it.each(["title", "summary"] as const)(
  "scheduler commits no-override %s after late canonical success and reopened persistence",
  (operation) =>
    withDatabase("bigbud-metadata-readiness-", async (dbPath) => {
      let runtime = createRuntime(dbPath);
      let time = Date.now();
      const now = () => new Date(time).toISOString();
      const calls: string[] = [];
      const compose = (engine: OrchestrationEngineShape, settings: ServerSettingsShape) => {
        const generate = Effect.fn("slowFirst.generate")(function* (
          attempt: MetadataTextGenerationAttempt | undefined,
        ) {
          if (!attempt) return yield* Effect.die("Missing captured attempt");
          yield* attempt.beforeDispatch();
          calls.push(attempt.selection.model);
          return "Repair slow first-turn metadata";
        });
        const unexpected = () => Effect.die("Unrelated generation path");
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
              Effect.map((s) => s.providers),
              Effect.orDie,
            ),
          withExecutionIdentity: (_context, _path, _snapshot, claim) => claim,
        };
        return makeThreadMetadataGeneration({
          engine,
          settings,
          textGeneration,
          executionIdentity,
          now,
        });
      };
      try {
        let engine = await engineFor(runtime);
        const threadId = ThreadId.makeUnsafe(`slow-first-${operation}`);
        for (const command of createCommands(ProjectId.makeUnsafe("slow-first"), [threadId])) {
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
            commandId: CommandId.makeUnsafe("slow-user"),
            threadId,
            message: {
              messageId: MessageId.makeUnsafe("slow-user"),
              role: "user",
              text: "Repair slow first-turn metadata",
              attachments: [],
            },
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: now(),
          }),
        );
        for (let index = 0; index < 4; index++) {
          // Persist the same strict message order that the in-memory capture observes.
          time += 1;
          await runtime.runPromise(
            engine.dispatch({
              type: "thread.message.assistant.complete",
              commandId: CommandId.makeUnsafe(`slow-assistant-${index}`),
              threadId,
              messageId: MessageId.makeUnsafe(`slow-assistant-${index}`),
              text: `Progress ${index}`,
              createdAt: now(),
            }),
          );
        }
        const original = await runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const settings = yield* ServerSettingsService;
              yield* settings.updateSettings({ textGenerationModelSelection: null });
              const repository = yield* makeThreadMetadataGenerationRepository();
              const service = yield* compose(engine, settings);
              yield* operation === "title"
                ? service.title({ threadId, messageText: "Repair slow first-turn metadata" })
                : service.summary({ threadId });
              const job = (yield* repository.listDue({ at: now(), limit: 100 }))[0]!;
              expect(job).toBeDefined();
              expect(Date.parse(job.deadlineAt) - Date.parse(job.createdAt)).toBe(1_800_000);
              // Retain a legacy readiness timestamp without changing its original job deadline.
              const sql = yield* SqlClient.SqlClient;
              const shortWait = new Date(time + 60_000).toISOString();
              yield* sql`UPDATE thread_metadata_generation_jobs SET model_wait_until = ${shortWait} WHERE job_id = ${job.jobId}`;
              yield* service.step(job.jobId);
              return { ...job, modelWaitUntil: shortWait };
            }),
          ),
        );
        await runtime.dispose();
        time += 65_000;
        runtime = createRuntime(dbPath);
        engine = await engineFor(runtime);
        await runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const settings = yield* ServerSettingsService;
              const repository = yield* makeThreadMetadataGenerationRepository();
              const resumed = yield* compose(engine, settings);
              yield* resumed.step(original.jobId);
              expect(Option.getOrThrow(yield* repository.get(original.jobId)).state).toBe(
                "waiting-model",
              );
              expect(calls).toEqual([]);
              yield* resumed.start();
              // Use the canonical production hook, not a direct successful-model SQL write.
              yield* engine.dispatch({
                type: "thread.activity.append",
                commandId: CommandId.makeUnsafe("slow-success"),
                threadId,
                createdAt: now(),
                activity: {
                  id: EventId.makeUnsafe("slow-success"),
                  kind: "text-generation.model-succeeded",
                  tone: "info",
                  turnId: null,
                  summary: "Verified model",
                  payload: { provider: "codex", model: "verified-after-65-seconds" },
                  createdAt: now(),
                },
              });
              expect((yield* repository.readMetadataState(threadId)).successfulModelJson).toContain(
                "verified-after-65-seconds",
              );
              time += 2_000;
              // Only the real scheduler may bind, dispatch, and commit after proof arrives.
              for (let poll = 0; poll < 100; poll++) {
                if (Option.getOrThrow(yield* repository.get(original.jobId)).state === "completed")
                  break;
                yield* Effect.sleep("100 millis");
                time += 100;
              }
              expect(calls).toEqual(["verified-after-65-seconds"]);
              const retained = Option.getOrThrow(yield* repository.get(original.jobId));
              expect(retained.state).toBe("completed");
              for (const field of [
                "createdAt",
                "deadlineAt",
                "modelWaitUntil",
                "nativeWaitUntil",
                "contextJson",
              ] as const)
                expect(retained[field]).toBe(original[field]);
              expect(
                (yield* repository.listAttempts(original.jobId)).map((a) => [
                  a.stage,
                  a.ordinal,
                  a.state,
                ]),
              ).toEqual([["thread-model", 1, "completed"]]);
              const thread = (yield* engine.ensureThreadState!(threadId, "history"))!;
              expect(operation === "title" ? thread.title : thread.elevatorSummary).toBe(
                "Repair slow first-turn metadata",
              );
              yield* operation === "title"
                ? resumed.title({ threadId, messageText: "Repair slow first-turn metadata" })
                : resumed.summary({ threadId });
              yield* resumed.step(original.jobId);
              expect(calls).toHaveLength(1);
            }),
          ),
        );
      } finally {
        await runtime.dispose();
      }
    }),
);
