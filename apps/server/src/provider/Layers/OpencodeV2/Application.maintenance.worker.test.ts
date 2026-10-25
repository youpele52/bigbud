import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Scope } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { admissionFixture } from "../../../persistence/Layers/ProviderTurnAdmissions.test.ts";
import { startV2AdmissionMaintenance } from "./Application.maintenance.ts";
import { toPersistenceSqlError } from "../../../persistence/Errors.ts";

const layer = ProviderTurnAdmissionsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
it.layer(layer)("application-owned single maintenance budget", (it) => {
  it.effect(
    "repository alone is inert; one initial run plus clock ticks stay <=25; failure recovers and scope disposal stops all writes",
    () =>
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const sql = yield* SqlClient.SqlClient;
        for (let index = 0; index < 110; index++) {
          let row = yield* journal.reserve(
            admissionFixture(`worker-${String(index).padStart(3, "0")}`),
          );
          row = yield* journal.transition(row, "dispatch-intent", row.createdAt);
          row = yield* journal.transition(row, "accepted", row.createdAt);
          yield* journal.transition(
            row,
            "terminal",
            row.createdAt,
            "worker retained ".repeat(1000),
            "completed",
          );
        }
        const count = () =>
          sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM provider_turn_admissions WHERE final_text_encoding = 'gzip'`.pipe(
            Effect.map((rows) => rows[0]!.count),
          );
        yield* TestClock.adjust("2 minutes");
        assert.equal(yield* count(), 0);
        let calls = 0,
          active = 0,
          maximum = 0,
          finished = 0;
        const owned = {
          ...journal,
          compactTerminal: (limit: number) =>
            Effect.gen(function* () {
              calls++;
              active++;
              maximum = Math.max(maximum, active);
              assert.equal(limit, 25);
              // Fail an actual candidate CAS once, exercising repository cursor recovery too.
              if (calls === 2)
                yield* sql`CREATE TRIGGER fail_worker_once BEFORE UPDATE OF final_text_encoding ON provider_turn_admissions BEGIN SELECT RAISE(ABORT, 'synthetic worker write failure'); END`;
              return yield* journal.compactTerminal(limit);
            }).pipe(
              Effect.mapError(toPersistenceSqlError("worker.fixture")),
              Effect.ensuring(
                Effect.sync(() => {
                  active--;
                  finished++;
                }),
              ),
            ),
        };
        const scope = yield* Scope.make();
        yield* startV2AdmissionMaintenance(owned).pipe(Scope.provide(scope));
        const isFinished = (target: number) => finished >= target;
        const wait = (target: number) =>
          Effect.gen(function* () {
            while (!isFinished(target)) yield* Effect.yieldNow;
          });
        yield* wait(1);
        assert.equal(yield* count(), 25);
        yield* TestClock.adjust("1 minute");
        yield* wait(2);
        assert.equal(yield* count(), 25);
        yield* sql`DROP TRIGGER fail_worker_once`;
        yield* TestClock.adjust("1 minute");
        yield* wait(3);
        assert.equal(yield* count(), 50);
        yield* TestClock.adjust("1 minute");
        yield* wait(4);
        assert.equal(yield* count(), 75);
        assert.equal(maximum, 1);
        assert.equal(calls, 4);
        yield* Scope.close(scope, Exit.void);
        yield* TestClock.adjust("5 minutes");
        assert.equal(calls, 4);
        assert.equal(yield* count(), 75);
        yield* journal.compactTerminal(25);
        yield* journal.compactTerminal(25);
        assert.equal(yield* count(), 110);
        assert.equal(
          (yield* journal.find(admissionFixture("worker-025")))?.finalText,
          "worker retained ".repeat(1000),
        );
      }),
  );
  it.effect(
    "concurrent explicit maintenance calls serialize their shared cursor and leave no skipped candidates",
    () =>
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        for (let index = 0; index < 60; index++) {
          let row = yield* journal.reserve(admissionFixture(`zz-cursor-${index}`));
          row = yield* journal.transition(row, "dispatch-intent", row.createdAt);
          row = yield* journal.transition(row, "accepted", row.createdAt);
          yield* journal.transition(
            row,
            "terminal",
            row.createdAt,
            "cursor ".repeat(1000),
            "completed",
          );
        }
        const counts = yield* Effect.all(
          [journal.compactTerminal(25), journal.compactTerminal(25), journal.compactTerminal(25)],
          { concurrency: 3 },
        );
        assert.deepEqual(counts, [25, 25, 10]);
      }),
  );
});
