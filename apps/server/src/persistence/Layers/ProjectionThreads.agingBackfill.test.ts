import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import {
  backfillOrganizationAgePage,
  ORGANIZATION_AGE_PAGE_SIZE,
} from "./ProjectionThreads.agingBackfill.ts";
import {
  ageEvent,
  ageRow,
  ageThread,
  OLD,
  RECENT,
} from "./ProjectionThreads.aging.test.helpers.ts";
import { makeSetThreadOrganization } from "./ProjectionThreads.organization.ts";
import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";

const run = <E>(test: Effect.Effect<void, E, SqlClient.SqlClient>) =>
  test.pipe(Effect.provide(NodeSqliteClient.layerMemory()));
const drain = Effect.gen(function* () {
  for (let pages = 0; pages < 20; pages++)
    if (yield* backfillOrganizationAgePage(yield* SqlClient.SqlClient)) return;
  assert.fail("backfill failed to finish in bounded fixture");
});

it.effect(
  "recovers automatic Later age but retains deliberate/ambiguous/missing/corrupt history",
  () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* ageThread("automatic", 2);
        yield* ageEvent("automatic", 1, { reason: "move", source: "deliberate", changedAt: OLD });
        yield* ageEvent("automatic", 2);
        yield* ageThread("ambiguous");
        yield* ageEvent("ambiguous", 1, { reason: "move" });
        yield* ageThread("missing", 2);
        yield* ageEvent("missing", 2);
        yield* ageThread("corrupt");
        yield* ageEvent("corrupt", 1, { malformed: true });
        yield* ageThread("all-auto");
        yield* ageEvent("all-auto", 1);
        yield* drain;
        assert.deepEqual(yield* ageRow("automatic"), { anchor: OLD, provenance: "known" });
        assert.deepEqual(yield* ageRow("all-auto"), { anchor: null, provenance: "known" });
        for (const id of ["missing", "corrupt"])
          assert.deepEqual(yield* ageRow(id), { anchor: RECENT, provenance: "fallback" });
        assert.deepEqual(yield* ageRow("ambiguous"), { anchor: RECENT, provenance: "known" });
        const plan = yield* sql`EXPLAIN QUERY PLAN SELECT thread_id FROM projection_threads
    WHERE organization_age_provenance = 'pending' AND organization_revision > 0
      AND thread_id > '' ORDER BY thread_id LIMIT 1`;
        assert.isTrue(JSON.stringify(plan).includes("idx_projection_threads_age_pending"));
      }),
    ),
);

it.effect("persists bounded event progress and does not overwrite a concurrent live move", () =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* ageThread("many", ORGANIZATION_AGE_PAGE_SIZE + 1);
      for (let revision = 1; revision <= ORGANIZATION_AGE_PAGE_SIZE + 1; revision++)
        yield* ageEvent("many", revision);
      assert.isFalse(yield* backfillOrganizationAgePage(sql));
      const [cursor] = yield* sql<{
        observed_revision: number;
      }>`SELECT observed_revision FROM projection_organization_age_backfill`;
      assert.equal(cursor?.observed_revision, ORGANIZATION_AGE_PAGE_SIZE);
      assert.equal((yield* ageRow("many"))?.provenance, "pending");
      yield* makeSetThreadOrganization(sql)({
        threadId: ThreadId.makeUnsafe("many"),
        reason: "move",
        source: "deliberate",
        organization: {
          state: "present",
          revision: ORGANIZATION_AGE_PAGE_SIZE + 2,
          changedAt: RECENT,
          snooze: null,
        },
      });
      yield* drain;
      assert.deepEqual(yield* ageRow("many"), { anchor: RECENT, provenance: "fallback" });
      yield* ageThread("earlier");
      yield* ageEvent("earlier", 1);
      yield* drain;
      assert.deepEqual(yield* ageRow("earlier"), { anchor: null, provenance: "known" });
    }),
  ),
);
