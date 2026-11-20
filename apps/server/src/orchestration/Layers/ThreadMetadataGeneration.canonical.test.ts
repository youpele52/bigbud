import { CommandId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it, vi } from "vitest";

import { ServerSettingsService } from "../../ws/serverSettings.ts";
import {
  readRows,
  setup,
  threadId,
} from "./OrchestrationEngine.metadataGeneration.test-helpers.ts";
import { createRuntime, engineFor, withDatabase } from "./OrchestrationEngine.test.runtime.ts";
import { makeMetadataCanonicalOperations } from "./ThreadMetadataGeneration.canonical.ts";
import { loadMetadataContext } from "./ThreadMetadataGeneration.modelBinding.ts";

const operationsFor = (runtime: ReturnType<typeof createRuntime>) =>
  runtime.runPromise(
    Effect.gen(function* () {
      return yield* makeMetadataCanonicalOperations({
        engine: yield* Effect.promise(() => engineFor(runtime)),
        settings: yield* ServerSettingsService,
      });
    }),
  );

describe("metadata canonical host operations", () => {
  it.each(["title", "summary"] as const)(
    "persists retained %s after restart and safely replays a lost commit response",
    (operation) =>
      withDatabase("bigbud-metadata-host-restart-", async (dbPath) => {
        const first = createRuntime(dbPath);
        const f = await setup(first, operation, true);
        await first.dispose();
        const second = createRuntime(dbPath);
        try {
          const host = await operationsFor(second);
          expect(await second.runPromise(host.isCurrent(f.context))).toBe(true);
          await second.runPromise(host.commitResult(f.job, f.attempt, f.context));
          // Retry uses original job/attempt and command identity, not fresh generation.
          await second.runPromise(host.commitResult(f.job, f.attempt, f.context));
          const engine = await engineFor(second);
          const thread = await second.runPromise(engine.ensureThreadState!(threadId, "history"));
          expect(operation === "title" ? thread?.title : thread?.elevatorSummary).toBe(
            f.attempt.result,
          );
          expect(await second.runPromise(readRows(f.command.commandId))).toEqual([
            { status: "accepted" },
          ]);
          expect(await second.runPromise(host.isCurrent(f.context))).toBe(false);
        } finally {
          await second.dispose();
        }
      }),
  );

  it("settles an explicit same-value title edit as stale with an accepted no-op receipt", () =>
    withDatabase("bigbud-metadata-host-stale-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const f = await setup(runtime);
        const host = await operationsFor(runtime);
        expect(await runtime.runPromise(host.isCurrent(f.context))).toBe(true);
        await runtime.runPromise(
          f.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe("explicit-same-title"),
            threadId,
            title: f.originalThread.title,
          }),
        );
        expect(await runtime.runPromise(host.isCurrent(f.context))).toBe(false);
        await runtime.runPromise(host.commitResult(f.job, f.attempt, f.context));
        expect((await runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]?.state).toBe(
          "stale",
        );
        expect(
          Option.getOrThrow(await runtime.runPromise(f.repository.get(f.job.jobId))).state,
        ).toBe("stale");
        expect(await runtime.runPromise(readRows(f.command.commandId))).toEqual([
          { status: "accepted" },
        ]);
        const thread = await runtime.runPromise(f.engine.ensureThreadState!(threadId, "history"));
        expect(thread?.title).toBe(f.originalThread.title);
      } finally {
        await runtime.dispose();
      }
    }));

  it("retains output and identity after persistence failure and retries only canonical dispatch", () =>
    withDatabase("bigbud-metadata-host-retry-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const f = await setup(runtime);
        const host = await operationsFor(runtime);
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`CREATE TEMP TRIGGER reject_host_receipt BEFORE INSERT ON orchestration_command_receipts
              WHEN NEW.status = 'accepted' BEGIN SELECT RAISE(ABORT, 'private provider detail'); END`;
          }),
        );
        expect(
          await runtime.runPromise(
            host.commitResult(f.job, f.attempt, f.context).pipe(Effect.result),
          ),
        ).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "MetadataCoordinatorError",
            detail: "Retained metadata result could not be committed.",
          },
        });
        expect((await runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]).toEqual(
          f.attempt,
        );
        expect(await runtime.runPromise(readRows(f.command.commandId))).toEqual([]);
        await runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`DROP TRIGGER reject_host_receipt`;
          }),
        );
        await runtime.runPromise(host.commitResult(f.job, f.attempt, f.context));
        expect((await runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]).toMatchObject(
          {
            state: "completed",
            result: f.attempt.result,
            owner: f.attempt.owner,
            payloadJson: f.attempt.payloadJson,
          },
        );
      } finally {
        await runtime.dispose();
      }
    }));

  it("requires settings and full-history authority rather than treating missing authority as stale", () =>
    withDatabase("bigbud-metadata-host-authority-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const f = await setup(runtime);
        const settings = await runtime.runPromise(Effect.service(ServerSettingsService));
        const noHistory = { ...f.engine };
        delete noHistory.withThreadHistoryBarrier;
        const noSettings = { ...settings };
        delete noSettings.withSnapshotBarrier;
        for (const input of [
          { engine: noHistory, settings },
          { engine: f.engine, settings: noSettings },
        ]) {
          const host = await runtime.runPromise(makeMetadataCanonicalOperations(input));
          expect(
            await runtime.runPromise(host.isCurrent(f.context).pipe(Effect.result)),
          ).toMatchObject({
            _tag: "Failure",
            failure: {
              _tag: "MetadataCoordinatorError",
              detail: "Metadata history preparation is unavailable.",
            },
          });
        }
        expect(Option.getOrThrow(await runtime.runPromise(f.repository.get(f.job.jobId)))).toEqual(
          f.job,
        );
      } finally {
        await runtime.dispose();
      }
    }));

  it("hydrates under settings authority without reacquiring the history semaphore", () =>
    withDatabase("bigbud-metadata-host-order-", async (dbPath) => {
      const runtime = createRuntime(dbPath);
      try {
        const f = await setup(runtime);
        const settings = await runtime.runPromise(Effect.service(ServerSettingsService));
        let settingsHeld = false;
        let historyHeld = false;
        const ensure = vi.fn(f.engine.ensureThreadState);
        const host = await runtime.runPromise(
          makeMetadataCanonicalOperations({
            settings: {
              ...settings,
              withSnapshotBarrier: (prepare) =>
                settings.withSnapshotBarrier!((snapshot) =>
                  Effect.sync(() => {
                    settingsHeld = true;
                  }).pipe(
                    Effect.andThen(Effect.suspend(() => prepare(snapshot))),
                    Effect.ensuring(
                      Effect.sync(() => {
                        settingsHeld = false;
                      }),
                    ),
                  ),
                ),
            },
            engine: {
              ...f.engine,
              ensureThreadState: ensure,
              withThreadHistoryBarrier: (id, prepare) =>
                f.engine.withThreadHistoryBarrier!(
                  id,
                  Effect.sync(() => {
                    expect(settingsHeld).toBe(true);
                    historyHeld = true;
                  }).pipe(
                    Effect.andThen(prepare),
                    Effect.ensuring(
                      Effect.sync(() => {
                        historyHeld = false;
                      }),
                    ),
                  ),
                ),
              getReadModel: () =>
                Effect.sync(() => {
                  expect(settingsHeld).toBe(true);
                  expect(historyHeld).toBe(true);
                }).pipe(Effect.andThen(f.engine.getReadModel())),
            },
          }),
        );
        const context = await runtime.runPromise(loadMetadataContext(f.repository, f.job));
        expect(await runtime.runPromise(host.isCurrent(context))).toBe(true);
        expect(ensure).not.toHaveBeenCalled();
        expect(settingsHeld).toBe(false);
        expect(historyHeld).toBe(false);
      } finally {
        await runtime.dispose();
      }
    }));
});
