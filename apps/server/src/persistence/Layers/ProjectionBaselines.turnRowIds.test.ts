import { ThreadId } from "@bigbud/contracts/core/baseSchemas.ts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { storedBaselinePayloadSource } from "../ProjectionBaselineRows.ts";
import { ProjectionBaselineRepository } from "../Services/ProjectionBaselines.ts";
import { ProjectionBaselineRepositoryLive } from "./ProjectionBaselines.ts";
import { insertCapturedBaseline } from "./ProjectionBaselines.test.helpers.ts";
import { insertProjectionThreadParent } from "./ProjectionThread.test.helpers.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const NOW = "2026-11-07T00:00:00.000Z";
const threadId = ThreadId.makeUnsafe("row-id-thread");

const freshRepository = () =>
  Layer.fresh(ProjectionBaselineRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const insertTurn = (turnId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_turns
      (thread_id, turn_id, pending_message_id, state, requested_at, started_at,
        checkpoint_files_json)
      VALUES (${threadId}, ${turnId}, ${`prompt-${turnId}`}, 'completed', ${NOW}, ${NOW}, '[]')`;
  });

const turnRowId = (turnId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly rowId: number }>`
      SELECT row_id AS "rowId" FROM projection_turns WHERE turn_id = ${turnId}`;
    return rows[0]!.rowId;
  });

it.effect("replays to the live hash when the turn row id sequence has a gap", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const baselines = yield* ProjectionBaselineRepository;
    yield* insertProjectionThreadParent({ sql, threadId, createdAt: NOW });
    yield* insertTurn("turn-1");
    const stored = yield* insertCapturedBaseline({
      sequence: 1,
      status: "verified",
      createdAt: NOW,
    });

    // Live: the newest turn row is deleted (revert, cleared pending start), leaving a gap in
    // `sqlite_sequence`, and the next turn gets an id past it.
    yield* insertTurn("turn-gap");
    yield* sql`DELETE FROM projection_turns WHERE turn_id = 'turn-gap'`;
    yield* insertTurn("turn-2");
    const liveRowId = yield* turnRowId("turn-2");
    const liveDigest = yield* baselines.captureDigest();

    // Replay: a fresh workspace restored from the baseline, whose sequence restarts at the
    // largest restored id, then replays the same turn.
    yield* baselines.restorePayload(
      storedBaselinePayloadSource(sql, stored.baselineId, stored.payloadHash),
      1,
      [],
    );
    yield* sql`UPDATE sqlite_sequence SET seq = (SELECT MAX(row_id) FROM projection_turns)
      WHERE name = 'projection_turns'`;
    yield* insertTurn("turn-2");
    const replayRowId = yield* turnRowId("turn-2");

    assert.notEqual(replayRowId, liveRowId, "the scenario must produce different row ids");
    assert.equal(yield* baselines.captureDigest(), liveDigest);
  }).pipe(Effect.provide(freshRepository())),
);

it.effect("stores turn rows without row_id and restores them with fresh ids", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const baselines = yield* ProjectionBaselineRepository;
    yield* insertProjectionThreadParent({ sql, threadId, createdAt: NOW });
    yield* insertTurn("turn-a");
    yield* insertTurn("turn-b");
    const stored = yield* insertCapturedBaseline({
      sequence: 2,
      status: "verified",
      createdAt: NOW,
    });

    const turnRows = yield* sql<{ readonly rowJson: string }>`
      SELECT row_json AS "rowJson" FROM projection_baseline_rows
      WHERE baseline_id = ${stored.baselineId} AND table_name = 'projection_turns'
      ORDER BY ordinal`;
    assert.equal(turnRows.length, 2);
    for (const row of turnRows) {
      assert.isFalse(Object.hasOwn(JSON.parse(row.rowJson), "row_id"));
    }

    yield* sql`DELETE FROM projection_turns WHERE turn_id = 'turn-b'`;
    yield* insertTurn("turn-not-in-baseline");
    yield* baselines.restorePayload(
      storedBaselinePayloadSource(sql, stored.baselineId, stored.payloadHash),
      2,
      [],
    );
    const restored = yield* sql<{ readonly turnId: string }>`
      SELECT turn_id AS "turnId" FROM projection_turns ORDER BY turn_id`;
    assert.deepEqual(
      restored.map((row) => row.turnId),
      ["turn-a", "turn-b"],
    );
    assert.equal(yield* baselines.captureDigest(), stored.payloadHash);
  }).pipe(Effect.provide(freshRepository())),
);
