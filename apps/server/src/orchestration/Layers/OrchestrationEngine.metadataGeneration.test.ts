import { CommandId, EventId, MessageId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { makeThreadMetadataGenerationRepository } from "../../persistence/Layers/ThreadMetadataGeneration.ts";
import { initialTime } from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";
import {
  readRows,
  setup,
  threadId,
} from "./OrchestrationEngine.metadataGeneration.test-helpers.ts";
import { createRuntime, engineFor, withDatabase } from "./OrchestrationEngine.test.runtime.ts";

describe("canonical metadata result transaction", () => {
  it.each(["title", "summary"] as const)(
    "commits %s, revisions, projection and receipt once across restart",
    (operation) =>
      withDatabase("bigbud-metadata-atomic-", async (dbPath) => {
        const first = createRuntime(dbPath);
        const f = await setup(first, operation);
        const revision = operation === "title" ? "titleRevision" : "summaryRevision";
        let sequence: number;
        try {
          sequence = (await first.runPromise(f.engine.dispatch(f.command, f.options))).sequence;
          expect((await first.runPromise(f.repository.listAttempts(f.job.jobId)))[0]?.state).toBe(
            "completed",
          );
          expect(
            Option.getOrThrow(await first.runPromise(f.repository.get(f.job.jobId))).state,
          ).toBe("completed");
          expect((await first.runPromise(f.repository.readMetadataState(threadId)))[revision]).toBe(
            1,
          );
          expect(await first.runPromise(readRows(f.command.commandId))).toEqual([
            { status: "accepted" },
          ]);
        } finally {
          await first.dispose();
        }
        const second = createRuntime(dbPath);
        try {
          const engine = await engineFor(second);
          expect(await second.runPromise(engine.dispatch(f.command, f.options))).toEqual({
            sequence: sequence!,
          });
          const repository = await second.runPromise(makeThreadMetadataGenerationRepository());
          expect((await second.runPromise(repository.readMetadataState(threadId)))[revision]).toBe(
            1,
          );
          const thread = await second.runPromise(engine.ensureThreadState!(threadId, "history"));
          expect(operation === "title" ? thread?.title : thread?.elevatorSummary).toBe(
            "Repair atomic metadata persistence",
          );
          if (operation === "summary") expect(thread?.elevatorSummaryMessageCount).toBe(1);
          await expect(
            second.runPromise(
              engine.dispatch({ ...f.command, title: "Changed payload" }, f.options),
            ),
          ).rejects.toThrow("payload digest does not match");
        } finally {
          await second.dispose();
        }
      }),
  );

  it.each(["title", "summary"] as const)(
    "authorizes a late-bound %s result after restarting before canonical persistence",
    (operation) =>
      withDatabase("bigbud-metadata-bound-", async (dbPath) => {
        const first = createRuntime(dbPath);
        const f = await setup(first, operation, true);
        try {
          expect(JSON.parse(f.job.contextJson)).toMatchObject({
            configuredPrimary: false,
            primaryPath: null,
            threadPath: null,
          });
          expect(f.attempt.state).toBe("result-ready");
          expect(await first.runPromise(readRows(f.command.commandId))).toEqual([]);
          // Later successful-model evidence cannot change an already-bound execution path.
          await first.runPromise(
            f.repository.recordSuccessfulModel(
              threadId,
              JSON.stringify({ provider: "codex", model: "newer" }),
            ),
          );
        } finally {
          await first.dispose();
        }
        const second = createRuntime(dbPath);
        try {
          const engine = await engineFor(second);
          const repository = await second.runPromise(makeThreadMetadataGenerationRepository());
          const before = Option.getOrThrow(await second.runPromise(repository.get(f.job.jobId)));
          expect(before).toEqual(f.job);
          const sequence = (await second.runPromise(engine.dispatch(f.command, f.options)))
            .sequence;
          expect(await second.runPromise(engine.dispatch(f.command, f.options))).toEqual({
            sequence,
          });
          expect(
            Option.getOrThrow(await second.runPromise(repository.get(f.job.jobId))).state,
          ).toBe("completed");
          expect((await second.runPromise(repository.listAttempts(f.job.jobId)))[0]?.state).toBe(
            "completed",
          );
          const revision = operation === "title" ? "titleRevision" : "summaryRevision";
          expect((await second.runPromise(repository.readMetadataState(threadId)))[revision]).toBe(
            1,
          );
          const thread = await second.runPromise(engine.ensureThreadState!(threadId, "history"));
          expect(operation === "title" ? thread?.title : thread?.elevatorSummary).toBe(
            "Repair atomic metadata persistence",
          );
          expect(await second.runPromise(readRows(f.command.commandId))).toEqual([
            { status: "accepted" },
          ]);
        } finally {
          await second.dispose();
        }
      }),
  );

  it.each(["title", "summary"] as const)(
    "rolls back %s, revision and settlement if the accepted receipt write fails",
    (operation) =>
      withDatabase("bigbud-metadata-rollback-", async (dbPath) => {
        const runtime = createRuntime(dbPath);
        try {
          const f = await setup(runtime, operation);
          await runtime.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`CREATE TEMP TRIGGER reject_metadata_receipt BEFORE INSERT ON orchestration_command_receipts
            WHEN NEW.status = 'accepted' BEGIN SELECT RAISE(ABORT, 'receipt failure'); END`;
            }),
          );
          await expect(
            runtime.runPromise(f.engine.dispatch(f.command, f.options)),
          ).rejects.toThrow();
          expect((await runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]).toEqual(
            f.attempt,
          );
          const state = await runtime.runPromise(f.repository.readMetadataState(threadId));
          expect(state.titleRevision).toBe(0);
          expect(state.summaryRevision).toBe(0);
          const thread = (await runtime.runPromise(f.engine.getReadModel())).threads.find(
            (t) => t.id === threadId,
          );
          expect(thread?.title).toBe("New thread");
          expect(thread?.elevatorSummary).toBe(f.originalThread.elevatorSummary);
          expect(await runtime.runPromise(readRows(f.command.commandId))).toEqual([]);
          await runtime.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql`DROP TRIGGER reject_metadata_receipt`;
            }),
          );
          await runtime.runPromise(f.engine.dispatch(f.command, f.options));
          expect((await runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]?.state).toBe(
            "completed",
          );
        } finally {
          await runtime.dispose();
        }
      }),
  );

  it.each(["manual-edit", "newer-revision", "workspace-change", "source-change"])(
    "settles stale output without overwriting %s",
    (change) =>
      withDatabase("bigbud-metadata-stale-", async (dbPath) => {
        const runtime = createRuntime(dbPath);
        try {
          const f = await setup(runtime);
          if (change === "manual-edit") {
            // Even an explicit edit to the same title fences the captured automatic result.
            await runtime.runPromise(
              f.engine.dispatch({
                type: "thread.meta.update",
                commandId: CommandId.makeUnsafe("manual"),
                threadId,
                title: "New thread",
              }),
            );
          } else if (change === "workspace-change") {
            await runtime.runPromise(
              f.engine.dispatch({
                type: "thread.meta.update",
                commandId: CommandId.makeUnsafe("workspace"),
                threadId,
                branch: "different-branch",
              }),
            );
          } else if (change === "source-change") {
            await runtime.runPromise(
              f.engine.dispatch({
                type: "thread.message.assistant.replace",
                commandId: CommandId.makeUnsafe("source-rewrite"),
                threadId,
                messageId: MessageId.makeUnsafe("source"),
                text: "Replaced source text",
                createdAt: initialTime,
              }),
            );
          } else {
            await runtime.runPromise(f.repository.advanceMetadataRevision(threadId, "title"));
          }
          await runtime.runPromise(f.engine.dispatch(f.command, f.options));
          expect(
            (await runtime.runPromise(f.engine.getReadModel())).threads.find(
              (t) => t.id === threadId,
            )?.title,
          ).toBe("New thread");
          expect((await runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]?.state).toBe(
            "stale",
          );
          expect(
            Option.getOrThrow(await runtime.runPromise(f.repository.get(f.job.jobId))).state,
          ).toBe("stale");
          expect(await runtime.runPromise(readRows(f.command.commandId))).toEqual([
            { status: "accepted" },
          ]);
        } finally {
          await runtime.dispose();
        }
      }),
  );

  it.each(["owner", "jobRevision", "attemptRevision", "payloadJson"] as const)(
    "refuses altered %s without poisoning persistence of the retained result",
    (field) =>
      withDatabase("bigbud-metadata-identity-", async (dbPath) => {
        const runtime = createRuntime(dbPath);
        try {
          const f = await setup(runtime);
          const identity = f.options.metadataCommit;
          const altered = {
            ...identity,
            [field]: typeof identity[field] === "number" ? Number(identity[field]) + 1 : "intruder",
          };
          await expect(
            runtime.runPromise(f.engine.dispatch(f.command, { metadataCommit: altered })),
          ).rejects.toThrow("ownership fence");
          expect((await runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]).toEqual(
            f.attempt,
          );
          expect(
            (await runtime.runPromise(f.repository.readMetadataState(threadId))).titleRevision,
          ).toBe(0);
          expect(await runtime.runPromise(readRows(f.command.commandId))).toEqual([]);
          // A refused envelope must not permit changing the already claimed command payload.
          await expect(
            runtime.runPromise(
              f.engine.dispatch({ ...f.command, title: "Changed payload" }, f.options),
            ),
          ).rejects.toThrow("payload digest does not match");
          await runtime.runPromise(f.engine.dispatch(f.command, f.options));
          expect((await runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]?.state).toBe(
            "completed",
          );
          expect(await runtime.runPromise(readRows(f.command.commandId))).toEqual([
            { status: "accepted" },
          ]);
        } finally {
          await runtime.dispose();
        }
      }),
  );

  it("persists successful model evidence in durable metadata state", () =>
    withDatabase("bigbud-metadata-model-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const f = await setup(runtime);
        const selection = {
          provider: "codex",
          model: "verified",
          options: { reasoningEffort: "high" },
        };
        await runtime.runPromise(
          f.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe("successful-model"),
            threadId,
            createdAt: initialTime,
            activity: {
              id: EventId.makeUnsafe("successful-model"),
              kind: "text-generation.model-succeeded",
              payload: selection,
              tone: "info",
              summary: "Successful thread model",
              turnId: null,
              createdAt: initialTime,
            },
          }),
        );
        expect(
          JSON.parse(
            (await runtime.runPromise(f.repository.readMetadataState(threadId)))
              .successfulModelJson!,
          ),
        ).toEqual(selection);
      } finally {
        await runtime.dispose();
      }
    }));
});
