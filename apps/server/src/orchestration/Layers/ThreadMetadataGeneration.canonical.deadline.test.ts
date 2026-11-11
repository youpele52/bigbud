import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it } from "vitest";

import { withAdmissionFixture } from "./ThreadMetadataGeneration.admission.test-helpers.ts";
import { makeMetadataCanonicalOperations } from "./ThreadMetadataGeneration.canonical.ts";

it.each(["settings", "history", "sql"] as const)(
  "bounds canonical freshness waiting for %s without settling work or retaining permits",
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
                  : Effect.scoped(sql.reserve.pipe(Effect.andThen(hold)))
            ).pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            const host = yield* makeMetadataCanonicalOperations(f.input);
            expect(yield* host.isCurrent(f.context).pipe(Effect.result)).toMatchObject({
              _tag: "Failure",
              failure: {
                _tag: "MetadataCoordinatorError",
                detail: "Metadata history preparation is unavailable.",
              },
            });
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(holder);
            expect((yield* f.repository.listAttempts(f.job.jobId))[0]).toEqual(f.attempt);
            expect(yield* host.isCurrent(f.context)).toBe(true);
            yield* f.settings.withSnapshotBarrier!(() => Effect.void);
            yield* f.engine.withThreadHistoryBarrier!(f.threadId, Effect.void);
          }),
        ),
      );
    }),
);
