import { CommandId } from "@bigbud/contracts/core/baseSchemas.ts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { makeMetadataDispatchAdmission } from "./ThreadMetadataGeneration.admission.ts";
import { withAdmissionFixture } from "./ThreadMetadataGeneration.admission.test-helpers.ts";

/** Real timers exercise production cancellation, including worker-backed SQL acquisition. */
describe("metadata preparation deadlines", () => {
  it.each(["settings", "history", "identity", "sql"] as const)(
    "bounds waiting for %s before claim and releases every permit",
    (boundary) =>
      withAdmissionFixture(async (f) => {
        await f.runtime.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const entered = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              const hold = Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
              );
              const sql = yield* SqlClient.SqlClient;
              const holder = yield* (
                boundary === "settings"
                  ? f.settings.withSnapshotBarrier!(() => hold)
                  : boundary === "history"
                    ? f.engine.withThreadHistoryBarrier!(f.threadId, hold)
                    : boundary === "sql"
                      ? Effect.scoped(sql.reserve.pipe(Effect.andThen(hold)))
                      : Deferred.succeed(entered, undefined)
              ).pipe(Effect.forkScoped);
              yield* Deferred.await(entered);
              const admit = yield* makeMetadataDispatchAdmission({
                ...f.input,
                withExecutionIdentity: (_context, _path, _snapshot, claim) =>
                  boundary === "identity" ? Effect.never : claim,
              });
              let claims = 0;
              const result = yield* admit(
                f.context,
                f.context.primaryPath!,
                Effect.sync(() => {
                  claims += 1;
                }),
              ).pipe(Effect.result);
              expect(result).toMatchObject({
                _tag: "Failure",
                failure: { metadataOutcome: "unavailable" },
              });
              expect(claims).toBe(0);
              yield* Deferred.succeed(release, undefined);
              yield* Fiber.join(holder);
              // A timed-out waiter must not later acquire or retain any of these permits.
              yield* f.settings.withSnapshotBarrier!(() => Effect.void);
              yield* f.engine.withThreadHistoryBarrier!(f.threadId, Effect.void);
              expect((yield* f.repository.listAttempts(f.job.jobId))[0]?.state).toBe("prepared");
              yield* f.admit(f.context, f.context.primaryPath!, f.claim);
              expect((yield* f.repository.listAttempts(f.job.jobId))[0]?.state).toBe(
                "dispatch-intent",
              );
            }),
          ),
        );
      }),
  );

  it("reports a deadline after claim begins as uncertain, even when rollback succeeds", () =>
    withAdmissionFixture(async (f) => {
      const result = await f.runtime.runPromise(
        f
          .admit(f.context, f.context.primaryPath!, f.claim.pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.result),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { metadataOutcome: "uncertain" },
      });
      expect((await f.runtime.runPromise(f.repository.listAttempts(f.job.jobId)))[0]?.state).toBe(
        "prepared",
      );
      await f.runtime.runPromise(f.admit(f.context, f.context.primaryPath!, f.claim));
    }));

  it("constructs synchronous identity verification only after acquiring full-history authority", () =>
    withAdmissionFixture(async (f) => {
      await f.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            let historyHeld = false;
            let identityCalled = false;
            const admit = yield* makeMetadataDispatchAdmission({
              ...f.input,
              engine: {
                ...f.engine,
                withThreadHistoryBarrier: (threadId, prepare) =>
                  f.engine.withThreadHistoryBarrier!(
                    threadId,
                    Effect.sync(() => {
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
              },
              withExecutionIdentity: (_context, _path, _snapshot, claim) => {
                expect(historyHeld).toBe(true);
                identityCalled = true;
                return claim;
              },
            });
            const holder = yield* f.engine.withThreadHistoryBarrier!(
              f.threadId,
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ).pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            const worker = yield* admit(f.context, f.context.primaryPath!, f.claim).pipe(
              Effect.forkScoped({ startImmediately: true }),
            );
            expect(identityCalled).toBe(false);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(holder);
            yield* Fiber.join(worker);
            expect(identityCalled).toBe(true);
          }),
        ),
      );
    }));

  it("cancellation before claim releases settings and history without a late claim", () =>
    withAdmissionFixture(async (f) => {
      await f.runtime.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            const admit = yield* makeMetadataDispatchAdmission({
              ...f.input,
              withExecutionIdentity: () =>
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            });
            const worker = yield* admit(f.context, f.context.primaryPath!, f.claim).pipe(
              Effect.forkScoped,
            );
            yield* Deferred.await(entered);
            yield* Fiber.interrupt(worker);
            yield* f.settings.updateSettings({ textGenerationModelSelection: null });
            yield* f.engine.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.makeUnsafe("after-cancellation"),
              threadId: f.threadId,
              title: "Owned by user",
            });
            expect((yield* f.repository.listAttempts(f.job.jobId))[0]?.state).toBe("prepared");
          }),
        ),
      );
    }));
});
