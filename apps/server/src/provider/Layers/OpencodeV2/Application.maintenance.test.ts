import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ProviderTurnAdmissions } from "../../../persistence/Services/ProviderTurnAdmissions.ts";
import { ProviderTurnAdmissionsLive } from "../../../persistence/Layers/ProviderTurnAdmissions.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { admissionFixture } from "../../../persistence/Layers/ProviderTurnAdmissions.test.ts";
import { inspectV2Admissions, maintainV2Admissions } from "./Application.maintenance.ts";

const layer = ProviderTurnAdmissionsLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));
it.layer(layer)("bounded non-dispatching maintenance", (it) => {
  it.effect(
    "startup inventory caps at 100; each maintenance pass compresses at most 25 without expiring terminal/reserved/unknown ownership",
    () =>
      Effect.gen(function* () {
        const journal = yield* ProviderTurnAdmissions;
        const sql = yield* SqlClient.SqlClient;
        for (let index = 0; index < 105; index++) {
          let row = yield* journal.reserve(admissionFixture(`inventory-${index}`));
          if (index % 2 === 0)
            row = yield* journal.transition(row, "dispatch-intent", row.createdAt);
        }
        for (let index = 0; index < 30; index++) {
          let row = yield* journal.reserve(admissionFixture(`compact-${index}`));
          row = yield* journal.transition(row, "dispatch-intent", row.createdAt);
          row = yield* journal.transition(row, "accepted", row.createdAt);
          yield* journal.transition(
            row,
            "terminal",
            row.createdAt,
            "immutable ".repeat(1000),
            "completed",
          );
        }
        assert.equal(yield* inspectV2Admissions(journal), 100);
        yield* maintainV2Admissions(journal);
        assert.deepEqual(
          yield* sql`SELECT final_text_encoding AS encoding, COUNT(*) AS count FROM provider_turn_admissions WHERE state = 'terminal' GROUP BY final_text_encoding ORDER BY final_text_encoding`,
          [
            { encoding: "gzip", count: 25 },
            { encoding: "plain", count: 5 },
          ],
        );
        yield* maintainV2Admissions(journal);
        assert.deepEqual(yield* sql`SELECT COUNT(*) AS count FROM provider_turn_admissions`, [
          { count: 135 },
        ]);
        assert.equal(
          (yield* journal.find(admissionFixture("inventory-0")))?.state,
          "dispatch-intent",
        );
        assert.equal((yield* journal.find(admissionFixture("inventory-1")))?.state, "reserved");
        assert.equal(
          (yield* journal.find(admissionFixture("compact-0")))?.finalText,
          "immutable ".repeat(1000),
        );
      }),
  );
});
