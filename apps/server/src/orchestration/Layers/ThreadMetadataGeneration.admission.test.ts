import { realpathSync } from "node:fs";

import { CommandId, MessageId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { makeThreadMetadataGenerationRepository } from "../../persistence/Layers/ThreadMetadataGeneration.ts";
import { seedActivity } from "../../persistence/Layers/ThreadMetadataGeneration.legacy.test-helpers.ts";
import { ServerSettingsService } from "../../ws/serverSettings.ts";
import { makeMetadataDispatchAdmission } from "./ThreadMetadataGeneration.admission.ts";
import {
  makeAdmissionFixture,
  withAdmissionFixture,
} from "./ThreadMetadataGeneration.admission.test-helpers.ts";
import { initialTime } from "./ThreadMetadataGeneration.coordinator.test-helpers.ts";
import { createRuntime, engineFor, withDatabase } from "./OrchestrationEngine.test.runtime.ts";

const failure = (result: { readonly _tag: string; readonly failure?: unknown }) => {
  expect(result._tag).toBe("Failure");
  return result.failure;
};

describe("durable metadata dispatch admission", () => {
  it("checks full SQL legacy evidence and claims in the same transaction", () =>
    withAdmissionFixture(async (f) => {
      await f.runtime.runPromise(
        seedActivity(f.threadId, "verified", "text-generation.model-succeeded", {
          provider: "codex",
          model: "verified-thread",
        }),
      );
      await f.runtime.runPromise(
        f.admit(
          f.context,
          f.context.primaryPath!,
          Effect.gen(function* () {
            expect(
              Option.isSome(yield* Effect.serviceOption(SqlClient.TransactionConnection)),
            ).toBe(true);
            yield* f.claim;
          }),
        ),
      );
      expect((await f.runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]?.state).toBe(
        "dispatch-intent",
      );
    }));

  it.each(["paid", "missing-receipt", "bad-digest"] as const)(
    "refuses %s legacy evidence before claim",
    (kind) =>
      withAdmissionFixture(async (f) => {
        const command = await f.runtime.runPromise(
          seedActivity(
            f.threadId,
            "legacy",
            kind === "paid" ? "text-generation.started" : "text-generation.model-succeeded",
            kind === "paid" ? { operation: "title" } : { provider: "codex", model: "verified" },
            kind !== "missing-receipt",
          ),
        );
        const sql = await f.runtime.runPromise(Effect.service(SqlClient.SqlClient));
        if (kind === "bad-digest")
          await f.runtime.runPromise(sql`UPDATE orchestration_command_receipts
        SET payload_digest = 'invalid' WHERE command_id = ${command.commandId}`);
        const before = await f.runtime.runPromise(
          sql`SELECT * FROM orchestration_command_receipts`,
        );
        let claimed = false;
        const result = await f.runtime.runPromise(
          f
            .admit(
              f.context,
              f.context.primaryPath!,
              Effect.sync(() => {
                claimed = true;
              }),
            )
            .pipe(Effect.result),
        );
        expect(failure(result)).toMatchObject({ metadataOutcome: "unavailable" });
        expect(claimed).toBe(false);
        expect(
          await f.runtime.runPromise(sql`SELECT * FROM orchestration_command_receipts`),
        ).toEqual(before);
        expect((await f.runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]?.state).toBe(
          "prepared",
        );
      }),
  );

  it.each(["history", "settings", "identity", "deletion"] as const)(
    "fails closed without %s authority",
    (missing) =>
      withAdmissionFixture(async (f) => {
        const engine = { ...f.engine };
        const settings = { ...f.settings };
        if (missing === "history") delete engine.withThreadHistoryBarrier;
        if (missing === "settings") delete settings.withSnapshotBarrier;
        if (missing === "deletion") delete engine.threadDeletion;
        const admit = await f.runtime.runPromise(
          makeMetadataDispatchAdmission({
            engine,
            settings,
            ...(missing === "identity"
              ? {}
              : { withExecutionIdentity: f.input.withExecutionIdentity }),
          }),
        );
        expect(
          failure(
            await f.runtime.runPromise(
              admit(f.context, f.context.primaryPath!, f.claim).pipe(Effect.result),
            ),
          ),
        ).toMatchObject({ metadataOutcome: "unavailable" });
        expect((await f.runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]?.state).toBe(
          "prepared",
        );
      }),
  );

  it.each(["remote-path", "remote-workspace", "uncaptured-options"] as const)(
    "refuses %s",
    (kind) =>
      withAdmissionFixture(async (f) => {
        const path =
          kind === "remote-path"
            ? { ...f.context.primaryPath!, executionTarget: "remote" }
            : kind === "uncaptured-options"
              ? {
                  ...f.context.primaryPath!,
                  selection: {
                    provider: "codex" as const,
                    model: f.context.primaryPath!.selection.model,
                    options: { reasoningEffort: "low" as const },
                  },
                }
              : f.context.primaryPath!;
        const context =
          kind === "remote-workspace"
            ? {
                ...f.context,
                workspace: {
                  ...f.context.workspace,
                  executionTarget: "remote",
                  cwd: "/remote/never-local",
                },
              }
            : f.context;
        expect(
          failure(await f.runtime.runPromise(f.admit(context, path, f.claim).pipe(Effect.result))),
        ).toMatchObject({ metadataOutcome: "unavailable" });
      }),
  );

  it.each(["manual-title", "revision", "source", "workspace", "deletion", "reservation"] as const)(
    "rechecks %s before claim",
    (change) =>
      withAdmissionFixture(async (f) => {
        const sql = await f.runtime.runPromise(Effect.service(SqlClient.SqlClient));
        if (change === "manual-title" || change === "workspace")
          await f.runtime.runPromise(
            f.engine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.makeUnsafe("change"),
              threadId: f.threadId,
              ...(change === "manual-title"
                ? { title: "New thread" }
                : { branch: "different-branch" }),
            }),
          );
        if (change === "revision")
          await f.runtime.runPromise(sql`INSERT INTO thread_metadata_generation_state
        (thread_id, title_revision) VALUES (${f.threadId}, 1)`);
        if (change === "source")
          await f.runtime.runPromise(
            f.engine.dispatch({
              type: "thread.message.assistant.replace",
              commandId: CommandId.makeUnsafe("rewrite"),
              threadId: f.threadId,
              messageId: MessageId.makeUnsafe("source"),
              text: "Different source",
              createdAt: initialTime,
            }),
          );
        if (change === "deletion")
          await f.runtime.runPromise(f.engine.threadDeletion!.acquireFence(f.threadId));
        if (change === "reservation")
          await f.runtime.runPromise(sql`INSERT INTO worktree_operations
        (operation_id, request_digest, kind, repository, cwd, source_path, destination_path, canonical_path,
          device, inode, branch, phase, created_at)
        VALUES ('move', 'digest', 'access', '/tmp', '/tmp', '/tmp', '/moved', ${realpathSync("/tmp")}, 1, 1,
          'workspace-mutation', 'dispatched', ${initialTime})`);
        expect(
          failure(
            await f.runtime.runPromise(
              f.admit(f.context, f.context.primaryPath!, f.claim).pipe(Effect.result),
            ),
          ),
        ).toMatchObject({ metadataOutcome: "unavailable" });
        expect((await f.runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]?.state).toBe(
          "prepared",
        );
      }),
  );

  it("rolls back the claim if the enclosing preparation transaction fails", () =>
    withAdmissionFixture(async (f) => {
      const sql = await f.runtime.runPromise(Effect.service(SqlClient.SqlClient));
      const result = await f.runtime.runPromise(
        f
          .admit(
            f.context,
            f.context.primaryPath!,
            f.claim.pipe(
              Effect.andThen(sql`SELECT * FROM nonexistent_metadata_admission_table`),
              Effect.asVoid,
              Effect.mapError(
                () =>
                  new PersistenceSqlError({
                    operation: "test.claim",
                    detail: "simulated lost claim",
                  }),
              ),
            ),
          )
          .pipe(Effect.result),
      );
      expect(result._tag).toBe("Failure");
      expect((await f.runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]?.state).toBe(
        "prepared",
      );
    }));

  it("holds settings and the engine barrier through identity verification and claim", () =>
    withAdmissionFixture(async (f) => {
      await f.runtime.runPromise(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const updated = yield* Deferred.make<void>();
          const edited = yield* Deferred.make<void>();
          const worker = yield* Effect.forkChild(
            f.admit(
              f.context,
              f.context.primaryPath!,
              Effect.gen(function* () {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                expect(yield* Deferred.isDone(updated)).toBe(false);
                expect(yield* Deferred.isDone(edited)).toBe(false);
                yield* f.claim;
              }),
            ),
          );
          yield* Deferred.await(entered);
          const settingsWriter = yield* Effect.forkChild(
            f.settings
              .updateSettings({ textGenerationModelSelection: null })
              .pipe(Effect.andThen(Deferred.succeed(updated, undefined))),
          );
          const engineWriter = yield* Effect.forkChild(
            f.engine
              .dispatch({
                type: "thread.meta.update",
                commandId: CommandId.makeUnsafe("queued-edit"),
                threadId: f.threadId,
                title: "Manual edit",
              })
              .pipe(Effect.andThen(Deferred.succeed(edited, undefined))),
          );
          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(worker);
          yield* Fiber.join(settingsWriter);
          yield* Fiber.join(engineWriter);
        }),
      );
    }));

  it("hydrates full thread history after restart without reacquiring its own semaphore", () =>
    withDatabase("bigbud-admission-history-", async (dbPath) => {
      const first = createRuntime(dbPath);
      let f: Awaited<ReturnType<typeof makeAdmissionFixture>>;
      try {
        f = await makeAdmissionFixture(first);
      } finally {
        await first.dispose();
      }
      const second = createRuntime(dbPath);
      try {
        const engine = await engineFor(second);
        const settings = await second.runPromise(Effect.service(ServerSettingsService));
        const repository = await second.runPromise(makeThreadMetadataGenerationRepository());
        const admit = await second.runPromise(
          makeMetadataDispatchAdmission({ ...f!.input, engine, settings }),
        );
        await second.runPromise(
          admit(
            f!.context,
            f!.context.primaryPath!,
            repository.claimDispatch(f!.attempt, initialTime).pipe(Effect.asVoid),
          ),
        );
        const thread = (await second.runPromise(engine.getReadModel())).threads.find(
          (t) => t.id === f!.threadId,
        )!;
        expect(thread.messages.map((m) => m.text)).toEqual(["Repair durable metadata recovery"]);
      } finally {
        await second.dispose();
      }
    }));
});
