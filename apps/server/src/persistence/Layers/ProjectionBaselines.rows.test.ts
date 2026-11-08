import { createHash } from "node:crypto";

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  BASELINE_PAYLOAD_PAGE_ROWS,
  storedBaselinePayloadSource,
} from "../ProjectionBaselineRows.ts";
import {
  type BaselinePayloadSource,
  ProjectionBaselineRepository,
} from "../Services/ProjectionBaselines.ts";
import { ProjectionBaselineRepositoryLive } from "./ProjectionBaselines.ts";
import {
  insertCapturedBaseline,
  materializeBaselinePayloadJson,
} from "./ProjectionBaselines.test.helpers.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const NOW = "2026-11-05T00:00:00.000Z";
const PROJECT_COUNT = 2 * BASELINE_PAYLOAD_PAGE_ROWS + 203;

const freshRepository = () =>
  Layer.fresh(ProjectionBaselineRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const insertProjects = (ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const id of ids) {
      yield* sql`INSERT INTO projection_projects (project_id, title, execution_target_id,
          workspace_root, scripts_json, created_at, updated_at)
        VALUES (${id}, ${`Title ${id}`}, 'local', '/tmp', '[]', ${NOW}, ${NOW})`;
    }
  });

const insertManyProjects = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < ${count})
      INSERT INTO projection_projects (project_id, title, execution_target_id, workspace_root,
        scripts_json, created_at, updated_at)
      SELECT 'bulk-' || value, 'Bulk ' || value, 'local', '/tmp', '[]', ${NOW}, ${NOW} FROM n`;
  });

const projectIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly id: string }>`SELECT project_id AS id FROM projection_projects
    WHERE project_id <> '__chats__' ORDER BY project_id`;
  return rows.map((row) => row.id);
});

/** Records the largest page a restore asked for and received. */
const spyOn = (source: BaselinePayloadSource) => {
  const seen = { largestLimit: 0, largestPage: 0, pages: 0 };
  const spy: BaselinePayloadSource = {
    payloadHash: source.payloadHash,
    readTablePage: (table, afterOrdinal, limit) =>
      source.readTablePage(table, afterOrdinal, limit).pipe(
        Effect.tap((rows) =>
          Effect.sync(() => {
            seen.largestLimit = Math.max(seen.largestLimit, limit);
            seen.largestPage = Math.max(seen.largestPage, rows.length);
            seen.pages += 1;
          }),
        ),
      ),
  };
  return { spy, seen };
};

it.effect("hashes the canonical document independent of row insertion order", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* insertProjects(["project-a", "project-b", "project-c"]);
    const first = yield* insertCapturedBaseline({
      sequence: 1,
      status: "verified",
      createdAt: NOW,
    });

    yield* sql`DELETE FROM projection_projects WHERE project_id <> '__chats__'`;
    yield* insertProjects(["project-c", "project-a", "project-b"]);
    const second = yield* insertCapturedBaseline({
      sequence: 2,
      status: "verified",
      createdAt: NOW,
    });

    assert.equal(first.payloadHash, second.payloadHash);
    const document = yield* materializeBaselinePayloadJson(
      storedBaselinePayloadSource(sql, first.baselineId, null),
    );
    assert.equal(createHash("sha256").update(document).digest("hex"), first.payloadHash);
    assert.equal(
      yield* (yield* ProjectionBaselineRepository).captureDigest(),
      first.payloadHash,
      "the workspace digest uses the same capture",
    );
    assert.deepEqual(
      yield* sql`SELECT COUNT(*) AS count FROM projection_baseline_rows WHERE baseline_id = 0`,
      [{ count: 0 }],
    );
  }).pipe(Effect.provide(freshRepository())),
);

it.effect("restores a multi-page baseline without reading more than one page at a time", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const baselines = yield* ProjectionBaselineRepository;
    yield* insertManyProjects(PROJECT_COUNT);
    const stored = yield* insertCapturedBaseline({
      sequence: 3,
      status: "verified",
      createdAt: NOW,
    });
    const expected = yield* projectIds;
    assert.equal(expected.length, PROJECT_COUNT);

    yield* sql`DELETE FROM projection_projects WHERE project_id LIKE 'bulk-1%'`;
    yield* insertProjects(["not-in-baseline"]);
    const { spy, seen } = spyOn(
      storedBaselinePayloadSource(sql, stored.baselineId, stored.payloadHash),
    );
    yield* baselines.restorePayload(spy, 3, []);

    assert.deepEqual(yield* projectIds, expected);
    assert.equal(seen.largestLimit, BASELINE_PAYLOAD_PAGE_ROWS);
    assert.equal(seen.largestPage, BASELINE_PAYLOAD_PAGE_ROWS);
    // Two passes over three pages of projects, plus one empty read per other table and pass.
    assert.isAtLeast(seen.pages, 6);
  }).pipe(Effect.provide(freshRepository())),
);

it.effect("rejects a tampered baseline before changing any projection row", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const baselines = yield* ProjectionBaselineRepository;
    yield* insertProjects(["project-a", "project-b"]);
    const stored = yield* insertCapturedBaseline({
      sequence: 4,
      status: "verified",
      createdAt: NOW,
    });
    yield* sql`UPDATE projection_baseline_rows SET row_json = replace(row_json, 'Title', 'Tampered')
      WHERE baseline_id = ${stored.baselineId} AND table_name = 'projection_projects'`;
    yield* insertProjects(["project-later"]);

    const result = yield* Effect.exit(
      baselines.restorePayload(
        storedBaselinePayloadSource(sql, stored.baselineId, stored.payloadHash),
        4,
        [],
      ),
    );

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.include(String(result.cause), "restorePayload:hash");
    assert.deepEqual(yield* projectIds, ["project-a", "project-b", "project-later"]);
  }).pipe(Effect.provide(freshRepository())),
);

it.effect("superseded and rejected baselines leave no stored rows behind", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const baselines = yield* ProjectionBaselineRepository;
    yield* insertProjects(["project-a"]);
    const older = yield* insertCapturedBaseline({
      sequence: 1,
      status: "verified",
      createdAt: NOW,
    });
    const newer = yield* insertCapturedBaseline({
      sequence: 2,
      status: "candidate",
      createdAt: NOW,
    });
    const rejected = yield* insertCapturedBaseline({
      sequence: 3,
      status: "candidate",
      createdAt: NOW,
    });

    yield* baselines.markVerified(newer.baselineId, 2, NOW);
    yield* baselines.markRejected(rejected.baselineId, "replay mismatch");

    const remaining = yield* sql<{ readonly baselineId: number }>`
      SELECT DISTINCT baseline_id AS "baselineId" FROM projection_baseline_rows`;
    assert.deepEqual(remaining, [{ baselineId: newer.baselineId }]);
    assert.notEqual(older.baselineId, newer.baselineId);
  }).pipe(Effect.provide(freshRepository())),
);
