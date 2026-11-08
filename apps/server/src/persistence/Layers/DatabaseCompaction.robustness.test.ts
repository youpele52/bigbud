import { existsSync, writeFileSync } from "node:fs";

import { assert, describe, it } from "@effect/vitest";
import { DatabaseCompactionStatus } from "@bigbud/contracts/server/databaseCompaction.ts";
import { Effect, Exit, Fiber, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeDatabaseCompaction } from "./DatabaseCompaction.ts";
import { detectSqliteExecution } from "./DatabaseCompaction.execution.ts";
import {
  CompactionMarkerError,
  compactionMarkerPath,
  parseCompactionMarker,
} from "./DatabaseCompaction.marker.ts";
import { INTERRUPTED_UNKNOWN } from "./DatabaseCompaction.recovery.ts";
import {
  fileSize,
  idleOptions,
  seedFragmentedDatabase,
  waitForIdle,
  withDatabase,
} from "./DatabaseCompaction.test.helpers.ts";

const failureCode = <A, E extends { readonly code: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error.code
    : null;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const encodeStatus = Schema.encodeSync(DatabaseCompactionStatus);

const instantRebuild = () =>
  Effect.succeed({
    autoVacuum: "incremental" as const,
    checkpoint: { busy: false, logPages: 0, checkpointedPages: 0 },
  });

describe("DatabaseCompaction SQLite execution", () => {
  it("treats Bun, a disabled worker and a missing worker entry as in-process", () => {
    const node = { isBun: false, workerMode: undefined, workerEntry: "/app/NodeSqliteWorker.mjs" };
    assert.equal(detectSqliteExecution(node), "worker");
    assert.equal(detectSqliteExecution({ ...node, workerMode: "all" }), "worker");
    assert.equal(detectSqliteExecution({ ...node, isBun: true }), "in-process");
    assert.equal(detectSqliteExecution({ ...node, workerMode: "0" }), "in-process");
    assert.equal(detectSqliteExecution({ ...node, workerMode: " FALSE " }), "in-process");
    assert.equal(detectSqliteExecution({ ...node, workerEntry: undefined }), "in-process");
  });

  it.live("refuses to start on an in-process client and reports why in the preview", () =>
    withDatabase("in-process", (dbPath) =>
      Effect.gen(function* () {
        yield* seedFragmentedDatabase({ rows: 1_000, keepEvery: 10 });
        const compaction = yield* makeDatabaseCompaction(
          idleOptions(dbPath, { sqliteExecution: "in-process" }),
        );
        const preview = yield* compaction.preview;
        assert.isTrue(preview.offered);
        assert.deepEqual(preview.blockers, ["in-process-sqlite"]);
        assert.equal(failureCode(yield* Effect.exit(compaction.start)), "in-process-sqlite");
        assert.equal((yield* compaction.status).state, "idle");
        assert.isFalse(existsSync(compactionMarkerPath(dbPath)));
      }),
    ),
  );
});

describe("DatabaseCompaction run robustness", () => {
  it.live("truncates the WAL after a failed rebuild", () =>
    withDatabase("failed-wal", (dbPath) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedFragmentedDatabase({ rows: 1_000, keepEvery: 10 });
        const compaction = yield* makeDatabaseCompaction(
          idleOptions(dbPath, {
            rebuild: (client) =>
              client
                .unsafe("SELECT * FROM missing_compaction_table")
                .pipe(Effect.flatMap(() => Effect.die("unreachable"))),
          }),
        );
        yield* sql`INSERT INTO filler (id, data) VALUES (100001, randomblob(64000))`;
        assert.isAbove(fileSize(`${dbPath}-wal`), 0);

        yield* compaction.start;
        const run = (yield* waitForIdle(compaction.status)).lastRun;
        assert.equal(run?.outcome, "failed");
        assert.match(run?.error ?? "", /missing_compaction_table/u);
        assert.isTrue(run?.checkpointComplete);
        assert.equal(fileSize(`${dbPath}-wal`), 0);
        assert.isFalse(existsSync(compactionMarkerPath(dbPath)));
      }),
    ),
  );

  it.live("returns to idle and reports it when the marker cannot be removed", () =>
    withDatabase("marker-eacces", (dbPath) =>
      Effect.gen(function* () {
        yield* seedFragmentedDatabase({ rows: 1_000, keepEvery: 10 });
        const compaction = yield* makeDatabaseCompaction(
          idleOptions(dbPath, {
            rebuild: instantRebuild,
            removeMarker: (path) =>
              Effect.fail(
                new CompactionMarkerError({
                  message: `Could not remove ${compactionMarkerPath(path)}: EACCES: permission denied`,
                  cause: null,
                }),
              ),
          }),
        );
        yield* compaction.start;
        const finished = yield* waitForIdle(compaction.status, 5_000);
        assert.equal(finished.state, "idle");
        assert.equal(finished.lastRun?.outcome, "completed");
        assert.match(finished.lastRun?.error ?? "", /EACCES/u);
        // Nothing is left paused: the steady-state step and a new preview both run.
        assert.isNull((yield* compaction.runSteadyStateStep({ idle: false })).skipped);
        assert.notInclude((yield* compaction.preview).blockers, "already-running");
      }),
    ),
  );

  it.live("releases the claim when start is interrupted before the marker is written", () =>
    withDatabase("start-interrupt", (dbPath) =>
      Effect.gen(function* () {
        yield* seedFragmentedDatabase({ rows: 1_000, keepEvery: 10 });
        const compaction = yield* makeDatabaseCompaction(
          idleOptions(dbPath, { readDiskFreeBytes: () => Effect.never }),
        );
        const fiber = yield* Effect.forkChild(compaction.start);
        while ((yield* compaction.status).state !== "running") yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
        assert.equal((yield* compaction.status).state, "idle");
        assert.isFalse(existsSync(compactionMarkerPath(dbPath)));
      }),
    ),
  );
});

describe("DatabaseCompaction recovery", () => {
  it("keeps only the marker fields that validate", () => {
    assert.deepEqual(
      parseCompactionMarker(
        JSON.stringify({ startedAt: "yesterday", bytesBefore: -5, autoVacuumBefore: "odd" }),
        "2026-11-07T09:00:00.000Z",
      ),
      {
        startedAt: null,
        bytesBefore: null,
        autoVacuumBefore: null,
        recordedAt: "2026-11-07T09:00:00.000Z",
      },
    );
    assert.equal(parseCompactionMarker("{not json", null).startedAt, null);
    assert.equal(
      parseCompactionMarker(JSON.stringify({ startedAt: "2026-11-07T10:00:00.000Z" }), null)
        .startedAt,
      "2026-11-07T10:00:00.000Z",
    );
  });

  it.live("reports an invalid marker as an unknown outcome with an encodable status", () =>
    withDatabase("marker-invalid", (dbPath) =>
      Effect.gen(function* () {
        yield* seedFragmentedDatabase({ rows: 200, keepEvery: 10 });
        writeFileSync(
          compactionMarkerPath(dbPath),
          JSON.stringify({ startedAt: "not a date", bytesBefore: 1.5, autoVacuumBefore: 7 }),
        );
        const status = yield* (yield* makeDatabaseCompaction(idleOptions(dbPath))).status;
        const run = status.lastRun;
        assert.equal(run?.outcome, "interrupted");
        assert.match(run?.startedAt ?? "", ISO);
        assert.isNull(run?.bytesBefore);
        // Still not incremental, so the rebuild certainly never committed.
        assert.match(run?.error ?? "", /not changed/u);
        assert.doesNotThrow(() => encodeStatus(status));

        writeFileSync(compactionMarkerPath(dbPath), "{truncated");
        const garbled = (yield* (yield* makeDatabaseCompaction(idleOptions(dbPath))).status)
          .lastRun;
        assert.equal(garbled?.outcome, "interrupted");
        assert.match(garbled?.startedAt ?? "", ISO);
        assert.isFalse(existsSync(compactionMarkerPath(dbPath)));
      }),
    ),
  );

  it.live("does not claim the file was unchanged after a crash on an incremental file", () =>
    withDatabase("marker-incremental", (dbPath) =>
      Effect.gen(function* () {
        yield* seedFragmentedDatabase({ rows: 1_000, keepEvery: 10 });
        const first = yield* makeDatabaseCompaction(idleOptions(dbPath));
        yield* first.start;
        assert.equal((yield* waitForIdle(first.status)).lastRun?.outcome, "completed");

        writeFileSync(
          compactionMarkerPath(dbPath),
          JSON.stringify({
            startedAt: "2026-11-07T10:00:00.000Z",
            bytesBefore: 123,
            autoVacuumBefore: "incremental",
          }),
        );
        const run = (yield* (yield* makeDatabaseCompaction(idleOptions(dbPath))).status).lastRun;
        assert.equal(run?.outcome, "interrupted");
        assert.equal(run?.error, INTERRUPTED_UNKNOWN);
        assert.notMatch(run?.error ?? "", /not changed/u);
      }),
    ),
  );
});
