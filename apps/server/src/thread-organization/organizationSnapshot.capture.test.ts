import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { insertProjectionThreadParent } from "../persistence/Layers/ProjectionThread.test.helpers.ts";
import { OrganizationLimit, OrganizationResync } from "./organizationLifecycle.ts";
import {
  makeOrganizationSnapshotCapture,
  ORGANIZATION_CAPTURE_BUDGET,
  organizationCaptureBudgetMs,
} from "./organizationSnapshot.capture.ts";

const AT = "2026-10-01T00:00:00.000Z";
const idle = { terminal: { state: "idle" as const, quietSince: null }, shell: "idle" as const };
const seed = (count: number) =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_state (projector, last_applied_sequence, updated_at) VALUES ('snapshot-test', 0, ${AT})`;
    for (let index = 0; index < count; index++)
      yield* insertProjectionThreadParent({
        sql,
        threadId: ThreadId.makeUnsafe(`thread-${String(index).padStart(4, "0")}`),
        createdAt: AT,
      });
    return sql;
  });

it.effect("paged capture leaves threads created mid-capture to the live event suffix", () =>
  Effect.gen(function* () {
    const sql = yield* seed(1);
    const created = ThreadId.makeUnsafe("a-new");
    let added = false;
    const snapshot = makeOrganizationSnapshotCapture({
      sql,
      owners: () =>
        Effect.gen(function* () {
          if (!added) {
            added = true;
            yield* insertProjectionThreadParent({ sql, threadId: created, createdAt: AT });
          }
          return idle;
        }),
    });
    const result = yield* snapshot(300000);
    assert.equal(result.frontier, 0);
    assert.deepEqual(
      result.rows.map((row) => row.threadId),
      ["thread-0000"],
    );
    assert.isTrue(result.rows.every((row) => row.factVersion > 0 && row.work === 1));
    const repeat = yield* snapshot(300000);
    assert.deepEqual(
      repeat.rows.map((row) => row.threadId),
      [created, "thread-0000"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("a concurrent canonical write commits between captured rows, not after the table", () =>
  Effect.gen(function* () {
    const sql = yield* seed(300);
    let sampled = 0;
    let committedAt: number | undefined;
    const capture = makeOrganizationSnapshotCapture({
      sql,
      owners: () =>
        Effect.gen(function* () {
          sampled += 1;
          if (sampled !== 50) return idle;
          // A whole-table capture transaction would hold the write lock here and time out.
          yield* sql
            .withTransaction(
              sql`UPDATE projection_threads SET organization_state = 'later' WHERE thread_id = 'thread-0200'`,
            )
            .pipe(Effect.timeout("2 seconds"));
          committedAt = sampled;
          return idle;
        }),
    });
    const result = yield* capture(300000);
    assert.equal(result.rows.length, 300);
    assert.equal(committedAt, 50);
    // Rows after the write observe it: no stale whole-table read was published.
    assert.equal(result.rows.find((row) => row.threadId === "thread-0200")?.section, 3);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("an over-budget capture is a routine resync, never a partial snapshot", () =>
  Effect.gen(function* () {
    const sql = yield* seed(5);
    let clock = 0;
    const capture = makeOrganizationSnapshotCapture({
      sql,
      now: () => clock,
      budgetMs: 1000,
      owners: () =>
        Effect.sync(() => {
          clock += 600;
          return idle;
        }),
    });
    const result = yield* Effect.result(capture(300000));
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.instanceOf(result.failure, OrganizationResync);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("snapshot refuses a lagging projection before sampling native owners", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_state (projector, last_applied_sequence, updated_at) VALUES ('lag-test', 1, '2026-11-05T00:00:00.000Z')`;
    let sampled = false;
    const capture = makeOrganizationSnapshotCapture({
      sql,
      owners: () =>
        Effect.sync(() => {
          sampled = true;
          return idle;
        }),
    });
    const result = yield* Effect.result(capture(300000));
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.instanceOf(result.failure, OrganizationResync);
    assert.isFalse(sampled);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it("the capture budget scales with membership and doubles per overrun up to its cap", () => {
  const B = ORGANIZATION_CAPTURE_BUDGET;
  assert.equal(organizationCaptureBudgetMs(100, 0), B.minMs);
  assert.equal(organizationCaptureBudgetMs(50_000, 0), 50_000 * B.perRowMs);
  assert.equal(organizationCaptureBudgetMs(50_000, 1), 2 * 50_000 * B.perRowMs);
  assert.equal(organizationCaptureBudgetMs(100_000, 3), B.maxMs);
  assert.equal(organizationCaptureBudgetMs(10, 1_000), B.maxMs);
});

it.effect("repeated overruns escalate the budget, then stop as a terminal limit at the cap", () =>
  Effect.gen(function* () {
    const sql = yield* seed(2);
    let clock = 0;
    const capture = makeOrganizationSnapshotCapture({
      sql,
      now: () => clock,
      owners: () =>
        Effect.sync(() => {
          clock += ORGANIZATION_CAPTURE_BUDGET.maxMs + 1;
          return idle;
        }),
    });
    const failures: unknown[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = yield* Effect.result(capture(300000));
      if (result._tag === "Failure") failures.push(result.failure);
    }
    // 120s, 240s, 480s, 960s overrun as resyncs; the capped 30min budget is terminal.
    assert.equal(failures.length, 6);
    assert.isTrue(failures.slice(0, 4).every((failure) => failure instanceof OrganizationResync));
    for (const failure of failures.slice(4)) {
      assert.instanceOf(failure, OrganizationLimit);
      assert.equal((failure as OrganizationLimit).reason, "capture-time");
    }
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("a table over the live row limit stops before any heavy per-row read", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_state (projector, last_applied_sequence, updated_at) VALUES ('limit-test', 0, ${AT})`;
    yield* sql`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < 100001)
      INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json,
        runtime_mode, interaction_mode, created_at, updated_at)
      SELECT printf('limit-%06d', n), 'limit-project', 'Synthetic',
        '{"provider":"codex","model":"fixture"}', 'full-access', 'default', ${AT}, ${AT} FROM ids`;
    let sampled = false;
    const capture = makeOrganizationSnapshotCapture({
      sql,
      owners: () =>
        Effect.sync(() => {
          sampled = true;
          return idle;
        }),
    });
    const result = yield* Effect.result(capture(300000));
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.instanceOf(result.failure, OrganizationLimit);
      assert.equal((result.failure as OrganizationLimit).reason, "thread-limit");
    }
    assert.isFalse(sampled);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
