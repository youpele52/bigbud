import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { makeLegacyMetadataAdmission } from "./ThreadMetadataGeneration.legacy.admission.ts";
import { seedThread } from "./ThreadMetadataGeneration.legacy.test-helpers.ts";

it.layer(SqlitePersistenceMemory)("legacy admission deadline", (it) => {
  it.effect("bounds waiting for the SQL transaction and never authorizes unread history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = yield* seedThread("legacy-admission-timeout");
        const admit = yield* makeLegacyMetadataAdmission();
        const sql = yield* SqlClient.SqlClient;
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const holder = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* Deferred.succeed(acquired, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(acquired);
        const waiting = yield* admit({ threadId, operation: "title" }).pipe(Effect.forkScoped);
        yield* TestClock.adjust("2 seconds");
        assert.deepStrictEqual(yield* Fiber.join(waiting), {
          allowed: false,
          reason: "scan-limit",
        });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        assert.deepStrictEqual(yield* admit({ threadId, operation: "title" }), {
          allowed: true,
          successfulModel: null,
        });
      }),
    ),
  );
});
