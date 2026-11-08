import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import type { EventLogMaintenanceProgress } from "@bigbud/contracts/server/eventLogMaintenance.ts";
import { Effect, Exit } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeDatabaseCompaction } from "./DatabaseCompaction.ts";
import { compactionMarkerPath } from "./DatabaseCompaction.marker.ts";
import {
  fileSize,
  fillerSummary,
  idleOptions,
  pragmaValue,
  seedFragmentedDatabase,
  waitForIdle,
  withDatabase,
} from "./DatabaseCompaction.test.helpers.ts";

const progress = (
  overrides: Partial<EventLogMaintenanceProgress> = {},
): EventLogMaintenanceProgress => ({
  state: "draining",
  backlogSequences: 0,
  floorSequence: 0,
  floorHeldBy: null,
  retainedThroughSequence: 0,
  ratePerMinute: 0,
  lastBatchAt: null,
  longestBatchMs: 0,
  starved: false,
  starvedSince: null,
  lastError: null,
  lastErrorAt: null,
  backoffUntil: null,
  ...overrides,
});

const failureCode = <A, E extends { readonly code: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error.code
    : null;

describe("DatabaseCompaction preconditions", () => {
  it.live("is not offered below the free-page threshold and refuses to start", () =>
    withDatabase("threshold", (dbPath) =>
      Effect.gen(function* () {
        yield* seedFragmentedDatabase({ rows: 400, keepEvery: 1 });
        const compaction = yield* makeDatabaseCompaction(idleOptions(dbPath));
        const preview = yield* compaction.preview;
        assert.isFalse(preview.offered);
        assert.deepEqual(preview.blockers, ["below-threshold"]);
        assert.equal(preview.autoVacuum, "none");
        const exit = yield* Effect.exit(compaction.start);
        assert.equal(failureCode(exit), "below-threshold");
        assert.equal((yield* compaction.status).state, "idle");
        assert.isFalse(existsSync(compactionMarkerPath(dbPath)));
      }),
    ),
  );

  it.live("needs free disk of at least the file plus its WAL", () =>
    withDatabase("disk", (dbPath) =>
      Effect.gen(function* () {
        yield* seedFragmentedDatabase({ rows: 1_000, keepEvery: 10 });
        const low = yield* makeDatabaseCompaction(
          idleOptions(dbPath, { readDiskFreeBytes: () => Effect.succeed(4096) }),
        );
        const preview = yield* low.preview;
        assert.isTrue(preview.offered);
        assert.deepEqual(preview.blockers, ["insufficient-disk"]);
        assert.equal(preview.requiredDiskBytes, preview.fileBytes + preview.walBytes);
        assert.equal(failureCode(yield* Effect.exit(low.start)), "insufficient-disk");

        const unknown = yield* makeDatabaseCompaction(
          idleOptions(dbPath, { readDiskFreeBytes: () => Effect.succeed(null) }),
        );
        assert.deepEqual((yield* unknown.preview).blockers, ["disk-unknown"]);
        assert.equal(failureCode(yield* Effect.exit(unknown.start)), "disk-unknown");
        assert.equal(yield* pragmaValue("auto_vacuum"), 0);
      }),
    ),
  );

  it.live("waits for running turns", () =>
    withDatabase("turns", (dbPath) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedFragmentedDatabase({ rows: 1_000, keepEvery: 10 });
        yield* sql`
          INSERT INTO projection_thread_sessions (thread_id, status, active_turn_id, updated_at)
          VALUES ('thread-1', 'running', 'turn-1', '2026-11-07T00:00:00.000Z'),
                 ('thread-2', 'ready', NULL, '2026-11-07T00:00:00.000Z')
        `;
        const compaction = yield* makeDatabaseCompaction(idleOptions(dbPath));
        const preview = yield* compaction.preview;
        assert.equal(preview.runningTurns, 1);
        assert.deepEqual(preview.blockers, ["running-turns"]);
        assert.equal(failureCode(yield* Effect.exit(compaction.start)), "running-turns");

        yield* sql`UPDATE projection_thread_sessions SET status = 'ready', active_turn_id = NULL`;
        assert.deepEqual((yield* compaction.preview).blockers, []);
      }),
    ),
  );

  it.live("waits while history cleanup is mid-drain, but not for a starved or disabled one", () =>
    withDatabase("backlog", (dbPath) =>
      Effect.gen(function* () {
        yield* seedFragmentedDatabase({ rows: 1_000, keepEvery: 10 });
        const blockersWith = (maintenance: EventLogMaintenanceProgress) =>
          makeDatabaseCompaction(
            idleOptions(dbPath, { maintenanceProgress: Effect.succeed(maintenance) }),
          ).pipe(
            Effect.flatMap((compaction) => compaction.preview),
            Effect.map((preview) => preview.blockers),
          );
        assert.deepEqual(yield* blockersWith(progress({ backlogSequences: 250_000 })), [
          "maintenance-backlog",
        ]);
        // The hot window keeps advancing, so a drained log still shows a small backlog.
        assert.deepEqual(yield* blockersWith(progress({ backlogSequences: 1_200 })), []);
        assert.deepEqual(
          yield* blockersWith(progress({ backlogSequences: 250_000, starved: true })),
          [],
        );
        assert.deepEqual(
          yield* blockersWith(progress({ backlogSequences: 250_000, state: "disabled" })),
          [],
        );
      }),
    ),
  );
});

describe("DatabaseCompaction rebuild", () => {
  it.live("shrinks the file, switches to incremental auto_vacuum and keeps every row", () =>
    withDatabase("vacuum", (dbPath) =>
      Effect.gen(function* () {
        yield* seedFragmentedDatabase({ rows: 4_000, keepEvery: 10 });
        const before = yield* fillerSummary;
        const compaction = yield* makeDatabaseCompaction(idleOptions(dbPath));
        const preview = yield* compaction.preview;
        assert.isTrue(preview.offered);
        assert.deepEqual(preview.blockers, []);
        assert.isAbove(preview.freeFraction, 0.8);
        assert.equal(
          preview.expectedBytes,
          (preview.pageCount - preview.freelistCount) * preview.pageSize,
        );
        assert.isAbove(preview.estimatedDurationMs, 0);
        const sizeBefore = fileSize(dbPath);

        const started = yield* compaction.start;
        assert.equal(started.state, "running");
        assert.isNotNull(started.startedAt);
        assert.isNotNull(started.estimatedDurationMs);
        assert.equal(failureCode(yield* Effect.exit(compaction.start)), "already-running");
        assert.equal(failureCode(yield* Effect.exit(compaction.preview)), "already-running");

        const finished = yield* waitForIdle(compaction.status);
        const run = finished.lastRun;
        assert.equal(run?.outcome, "completed");
        assert.equal(run?.bytesBefore, sizeBefore);
        assert.isTrue(run?.checkpointComplete);
        assert.equal(run?.bytesAfter, fileSize(dbPath));
        assert.isBelow(fileSize(dbPath), sizeBefore * 0.3);
        // Within one page per table of the predicted size.
        assert.isAtMost(fileSize(dbPath), preview.expectedBytes + 4 * preview.pageSize);
        assert.equal(fileSize(`${dbPath}-wal`), 0);
        assert.equal(yield* pragmaValue("auto_vacuum"), 2);
        assert.equal(yield* pragmaValue("freelist_count"), 0);
        assert.deepEqual(yield* fillerSummary, before);
        assert.isFalse(existsSync(compactionMarkerPath(dbPath)));
        // Nothing left to reclaim, so the action is no longer offered.
        assert.deepEqual((yield* compaction.preview).blockers, ["below-threshold"]);
      }),
    ),
  );

  it.live("reports a failed VACUUM and leaves the database unchanged", () =>
    withDatabase("failed", (dbPath) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedFragmentedDatabase({ rows: 2_000, keepEvery: 10 });
        yield* sql`PRAGMA busy_timeout = 100`;
        const before = yield* fillerSummary;
        const pagesBefore = yield* pragmaValue("page_count");
        const compaction = yield* makeDatabaseCompaction(idleOptions(dbPath));

        // Another connection holds the write lock, so VACUUM fails with SQLITE_BUSY.
        const other = new DatabaseSync(dbPath);
        other.exec("BEGIN IMMEDIATE");
        try {
          yield* compaction.start;
          const run = (yield* waitForIdle(compaction.status)).lastRun;
          assert.equal(run?.outcome, "failed");
          assert.match(run?.error ?? "", /locked|busy/i);
          assert.isNull(run?.bytesAfter);
        } finally {
          other.exec("ROLLBACK");
          other.close();
        }
        assert.equal(yield* pragmaValue("auto_vacuum"), 0);
        assert.equal(yield* pragmaValue("page_count"), pagesBefore);
        assert.deepEqual(yield* fillerSummary, before);
        assert.isFalse(existsSync(compactionMarkerPath(dbPath)));
        assert.deepEqual((yield* compaction.preview).blockers, []);
      }),
    ),
  );

  it.live("reports a run an earlier process left unfinished, and one that committed", () =>
    withDatabase("marker", (dbPath) =>
      Effect.gen(function* () {
        yield* seedFragmentedDatabase({ rows: 1_000, keepEvery: 10 });
        const marker = (autoVacuumBefore: string) =>
          writeFileSync(
            compactionMarkerPath(dbPath),
            JSON.stringify({
              startedAt: "2026-11-07T10:00:00.000Z",
              bytesBefore: 123,
              autoVacuumBefore,
            }),
          );

        marker("none");
        const interrupted = (yield* (yield* makeDatabaseCompaction(idleOptions(dbPath))).status)
          .lastRun;
        assert.equal(interrupted?.outcome, "interrupted");
        assert.equal(interrupted?.bytesBefore, 123);
        assert.isFalse(existsSync(compactionMarkerPath(dbPath)));

        const compaction = yield* makeDatabaseCompaction(idleOptions(dbPath));
        assert.isNull((yield* compaction.status).lastRun);
        yield* compaction.start;
        yield* waitForIdle(compaction.status);

        marker("none");
        const committed = (yield* (yield* makeDatabaseCompaction(idleOptions(dbPath))).status)
          .lastRun;
        assert.equal(committed?.outcome, "completed");
        assert.equal(committed?.bytesAfter, fileSize(dbPath));
      }),
    ),
  );
});
