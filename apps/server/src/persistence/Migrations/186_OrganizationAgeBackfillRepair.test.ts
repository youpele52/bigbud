import { assert, it } from "@effect/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { ProjectionBaselineRepositoryLive } from "../Layers/ProjectionBaselines.ts";
import { ProjectionBaselineRepository } from "../Services/ProjectionBaselines.ts";
import { backfillOrganizationAgePage } from "../Layers/ProjectionThreads.agingBackfill.ts";
import { ageEvent, ageRow, ageThread } from "../Layers/ProjectionThreads.aging.test.helpers.ts";

const layer = ProjectionBaselineRepositoryLive.pipe(
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
);
const fileLayer = (filename: string) =>
  ProjectionBaselineRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));

// Shape of migration 148 as applied by development databases before `last_changed_at` landed.
const recreateDriftedBackfillTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE projection_organization_age_backfill`;
  yield* sql`CREATE TABLE projection_organization_age_backfill (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    after_thread_id TEXT NOT NULL DEFAULT '',
    thread_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    event_cursor INTEGER NOT NULL DEFAULT 0,
    observed_revision INTEGER NOT NULL DEFAULT 0,
    anchor TEXT,
    invalid INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`INSERT INTO projection_organization_age_backfill (singleton) VALUES (1)`;
});

const createCandidateAtHead = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const baselines = yield* ProjectionBaselineRepository;
  const [head] = yield* sql<{ readonly sequence: number }>`
    SELECT MAX(sequence) AS sequence FROM orchestration_events`;
  yield* sql`INSERT OR REPLACE INTO projection_state (projector, last_applied_sequence, updated_at)
    VALUES ('projection.test', ${head?.sequence ?? 0}, '2026-11-26T00:00:00.000Z')`;
  return yield* baselines.createCandidate(["projection.test"]);
});

it.effect("repairs a drifted 148 backfill table so the projection baseline can advance", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "bigbud-186-"))),
    (directory) => {
      const filename = join(directory, "state.sqlite");
      // Each phase is a fresh connection: migrations only run at server startup, so the repair
      // is always observed by a newly opened client, as in production.
      const drifted = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 185 });
        yield* recreateDriftedBackfillTable;
        yield* ageThread("stuck");
        yield* ageEvent("stuck", 1);

        // Reproduction: every backfill page fails, the thread stays pending, and no baseline
        // candidate can be created, so ensureBaseline never reaches the requested sequence.
        const failed = yield* Effect.flip(backfillOrganizationAgePage(sql));
        assert.include(String(failed.reason.cause), "no such column: last_changed_at");
        assert.equal((yield* ageRow("stuck"))?.provenance, "pending");
        assert.isTrue(Option.isNone(yield* createCandidateAtHead));
      }).pipe(Effect.provide(fileLayer(filename)));
      const repaired = Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 186 });
        for (let pages = 0; pages < 10; pages++) if (yield* backfillOrganizationAgePage(sql)) break;
        assert.equal((yield* ageRow("stuck"))?.provenance, "known");
        assert.isTrue(Option.isSome(yield* createCandidateAtHead));
      }).pipe(Effect.provide(fileLayer(filename)));
      return Effect.andThen(drifted, repaired);
    },
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  ),
);

it.effect("leaves an already-correct backfill table and its progress untouched", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 185 });
    yield* sql`UPDATE projection_organization_age_backfill SET after_thread_id = 'kept'`;
    yield* runMigrations({ toMigrationInclusive: 186 });
    const [row] = yield* sql<{ readonly after: string }>`
      SELECT after_thread_id AS after FROM projection_organization_age_backfill`;
    assert.equal(row?.after, "kept");
  }).pipe(Effect.provide(layer)),
);
