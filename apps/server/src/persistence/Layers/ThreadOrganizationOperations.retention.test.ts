import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { operation } from "./ThreadOrganizationOperations.test.helpers.ts";
import {
  makeThreadOrganizationOperations,
  ORGANIZATION_OPERATION_RETENTION,
} from "./ThreadOrganizationOperations.ts";

const DAY = 24 * 60 * 60 * 1000;
const now = 30 * DAY;
const old = now - ORGANIZATION_OPERATION_RETENTION.ageMs - DAY;
const recent = now - DAY;
const applied = { status: "applied" as const, resultRevision: 2, resultSequence: 7 };

it.effect("prunes only settled history no retransmission, retry chain or Undo can need", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const ledger = yield* makeThreadOrganizationOperations;
    const add = Effect.fn(function* (
      id: string,
      createdAtMs: number,
      outcome?: Parameters<typeof ledger.settle>[1],
    ) {
      const value = { ...operation, operationId: id, occurrenceId: id, threadId: id, createdAtMs };
      assert.equal((yield* ledger.prepare(value)).status, "prepared");
      if (outcome) assert.equal(yield* ledger.settle(id, outcome), "applied");
      return value;
    });
    yield* add("old-applied", old, applied);
    yield* add("old-stale", old, { status: "stale" });
    yield* add("old-not-due-elapsed", old, { status: "not-due", retryNotBeforeMs: old + 5000 });
    const waiting = yield* add("old-not-due-waiting", old, {
      status: "not-due",
      retryNotBeforeMs: now + DAY,
    });
    yield* add("old-prepared", old);
    yield* add("old-undo-target", old, applied);
    yield* add("recent-stale", recent, { status: "stale" });
    yield* sql`INSERT INTO thread_organization_runtime_threads
      (thread_id, fact_version, source_frontier, transition_digest, attention_watermark, latest_automatic_move_id)
      VALUES ('old-undo-target', 1, 0, '', 0, 'old-undo-target')`;

    assert.equal(yield* ledger.prune(now), 3);
    for (const id of ["old-applied", "old-stale", "old-not-due-elapsed"])
      assert.equal(yield* ledger.read(id), undefined);
    for (const id of ["old-not-due-waiting", "old-prepared", "old-undo-target", "recent-stale"])
      assert.notEqual(yield* ledger.read(id), undefined);
    assert.equal(yield* ledger.prune(now), 0);
    // The kept not-due row still anchors its retry chain.
    const retry = { ...waiting, operationId: "retry", attempt: 1, createdAtMs: now + DAY };
    assert.equal((yield* ledger.prepare(retry)).status, "prepared");
    assert.equal((yield* ledger.pending()).length, 2);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("drains a backlog larger than one batch", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const sql = yield* SqlClient.SqlClient;
    const ledger = yield* makeThreadOrganizationOperations;
    const count = ORGANIZATION_OPERATION_RETENTION.batch * 2 + 1;
    yield* sql`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < ${count})
      INSERT INTO thread_organization_operations (operation_id, occurrence_id, attempt, thread_id,
        payload_digest, payload_json, created_at_ms, status, outcome_json)
      SELECT 'bulk-' || n, 'bulk-' || n, 0, 'bulk-' || n, 'digest', '{}', ${old}, 'stale',
        '{"status":"stale"}' FROM ids`;
    assert.equal(yield* ledger.prune(now), count);
    const [left] = yield* sql<{
      count: number;
    }>`SELECT COUNT(*) AS count FROM thread_organization_operations`;
    assert.equal(left?.count, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
