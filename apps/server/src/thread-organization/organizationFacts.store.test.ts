import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../persistence/Layers/ProjectionThread.test.helpers.ts";
import { makeOrganizationFactStore } from "./organizationFacts.store.ts";
import type { OrganizationOwnerFacts } from "./organizationFacts.build.ts";

const id = ThreadId.makeUnsafe("facts-thread");
const OLD = "2026-10-01T00:00:00.000Z";
const setup = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* SqlClient.SqlClient;
  yield* insertProjectionThreadParent({ sql, threadId: id, createdAt: OLD });
  yield* sql`UPDATE projection_threads SET last_activity_at = ${OLD} WHERE thread_id = ${id}`;
  return sql;
});

it.effect(
  "owner work is uniform, unknown protects, and confirmed completion grants durable grace",
  () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      let now = Date.parse("2026-11-05T00:00:00.000Z");
      let owners: OrganizationOwnerFacts = {
        terminal: { state: "busy", quietSince: null },
        shell: "idle",
      };
      const store = makeOrganizationFactStore({
        sql,
        now: () => now,
        owners: () => Effect.succeed(owners),
      });
      const active = yield* store.observe(id, 300000);
      assert.equal(active.row?.work, 2);
      assert.equal((yield* store.observe(id, 300000)).status, "unchanged");
      owners = { terminal: { state: "unknown", quietSince: null }, shell: "idle" };
      assert.equal((yield* store.observe(id, 300000)).row?.work, 3);
      owners = { terminal: { state: "idle", quietSince: null }, shell: "active" };
      assert.equal((yield* store.observe(id, 300000)).row?.work, 2);
      now += 1000;
      owners = { terminal: { state: "idle", quietSince: now }, shell: "idle" };
      const finished = yield* store.observe(id, 300000);
      assert.equal(finished.row?.work, 1);
      assert.equal(finished.row?.inactivityAtMs, now);
      assert.equal(finished.row?.graceUntilMs, now + 300000);
      now += 1000;
      const same = yield* store.observe(id, 300000);
      assert.equal(same.status, "unchanged");
      assert.equal(same.row?.graceUntilMs, now - 1000 + 300000);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect(
  "a request identity gains a watermark once, and raw-state races cannot publish stale reads",
  () =>
    Effect.gen(function* () {
      const sql = yield* setup;
      let race = false;
      const owners = Effect.gen(function* () {
        if (race)
          yield* sql`UPDATE projection_threads SET organization_revision = organization_revision + 1 WHERE thread_id = ${id}`;
        return { terminal: { state: "idle" as const, quietSince: null }, shell: "idle" as const };
      });
      const store = makeOrganizationFactStore({
        sql,
        now: () => Date.parse(OLD),
        owners: () => owners,
      });
      yield* store.observe(id, 300000);
      yield* sql`INSERT INTO projection_pending_approvals (request_id, thread_id, status, created_at)
    VALUES ('approval', ${id}, 'pending', ${OLD})`;
      const requested = yield* store.observe(id, 300000);
      assert.equal(requested.row?.actionable, true);
      assert.equal(requested.row?.attentionWatermark, 1);
      assert.equal((yield* store.observe(id, 300000)).row?.attentionWatermark, 1);
      yield* sql`DELETE FROM projection_pending_approvals WHERE request_id = 'approval'`;
      yield* store.observe(id, 300000);
      yield* sql`INSERT INTO projection_pending_approvals (request_id, thread_id, status, created_at)
    VALUES ('approval', ${id}, 'pending', ${OLD})`;
      assert.equal((yield* store.observe(id, 300000)).row?.attentionWatermark, 2);
      race = true;
      assert.equal((yield* store.observe(id, 300000)).status, "stale");
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("frontier advances during owner sampling without making observation fatal", () =>
  Effect.gen(function* () {
    const sql = yield* setup;
    const store = makeOrganizationFactStore({
      sql,
      now: () => Date.parse(OLD),
      owners: () =>
        Effect.gen(function* () {
          yield* sql`UPDATE thread_organization_runtime SET canonical_frontier = 10 WHERE singleton = 1`;
          return { terminal: { state: "idle" as const, quietSince: null }, shell: "idle" as const };
        }),
    });
    const observed = yield* store.observe(id, 300000);
    assert.equal(observed.status, "applied");
    assert.equal(observed.frontier, 10);
    const [stored] = yield* sql<{
      source_frontier: number;
    }>`SELECT source_frontier FROM thread_organization_runtime_threads WHERE thread_id = ${id}`;
    assert.equal(stored?.source_frontier, 10);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
