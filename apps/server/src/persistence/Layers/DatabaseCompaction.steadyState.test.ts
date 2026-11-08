import { DatabaseSync } from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeDatabaseCompaction } from "./DatabaseCompaction.ts";
import { STEADY_STATE } from "./DatabaseCompaction.policy.ts";
import {
  fileSize,
  fillerSummary,
  idleOptions,
  pragmaValue,
  seedFragmentedDatabase,
  waitForIdle,
  withDatabase,
} from "./DatabaseCompaction.test.helpers.ts";

/** Compacts once, so the file is in INCREMENTAL mode, then frees most pages again. */
const incrementalWithFreePages = (dbPath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seedFragmentedDatabase({ rows: 10_000, keepEvery: 2 });
    const compaction = yield* makeDatabaseCompaction(idleOptions(dbPath));
    yield* compaction.start;
    assert.equal((yield* waitForIdle(compaction.status)).lastRun?.outcome, "completed");
    yield* sql`DELETE FROM filler WHERE id % 4 != 0`;
    return compaction;
  });

describe("DatabaseCompaction steady state", () => {
  it.live("sets journal_size_limit to 64 MB on the write connection at startup", () =>
    withDatabase("journal", (dbPath) =>
      Effect.gen(function* () {
        yield* seedFragmentedDatabase({ rows: 10, keepEvery: 1 });
        assert.equal(yield* pragmaValue("journal_size_limit"), -1);
        const compaction = yield* makeDatabaseCompaction(idleOptions(dbPath));
        assert.equal(yield* pragmaValue("journal_size_limit"), STEADY_STATE.journalSizeLimitBytes);
        const report = yield* compaction.runSteadyStateStep({ idle: false });
        // Already applied once for this connection.
        assert.isFalse(report.journalSizeLimitApplied);
        assert.isNull(report.error);
      }),
    ),
  );

  it.live(
    `releases ${STEADY_STATE.incrementalPages.toLocaleString("en-US")} pages per step once incremental and above 10% free`,
    () =>
      withDatabase("incremental", (dbPath) =>
        Effect.gen(function* () {
          const compaction = yield* incrementalWithFreePages(dbPath);
          const before = yield* fillerSummary;
          const freeBefore = yield* pragmaValue("freelist_count");
          const pagesBefore = yield* pragmaValue("page_count");
          assert.isAbove(freeBefore, STEADY_STATE.incrementalPages);
          assert.isAbove(freeBefore / pagesBefore, STEADY_STATE.minFreeFraction);

          const report = yield* compaction.runSteadyStateStep({ idle: false });
          assert.isNull(report.skipped);
          assert.isNull(report.error);
          assert.isTrue(report.autoVacuumIncremental);
          assert.equal(report.pagesReleased, STEADY_STATE.incrementalPages);
          assert.isNull(report.checkpoint);
          assert.equal(yield* pragmaValue("freelist_count"), freeBefore - report.pagesReleased);
          // Pointer-map pages can go too, so the file shrinks by at least the released pages.
          assert.isAtMost(yield* pragmaValue("page_count"), pagesBefore - report.pagesReleased);
          assert.deepEqual(yield* fillerSummary, before);

          // Repeated steps stop once free pages are at or below 10%.
          for (let step = 0; step < 20; step += 1) {
            if ((yield* compaction.runSteadyStateStep({ idle: false })).pagesReleased === 0) break;
          }
          const free = yield* pragmaValue("freelist_count");
          assert.isAtMost(free / (yield* pragmaValue("page_count")), STEADY_STATE.minFreeFraction);
          assert.deepEqual(yield* fillerSummary, before);
        }),
      ),
  );

  it.live("leaves free pages alone without incremental auto_vacuum", () =>
    withDatabase("none", (dbPath) =>
      Effect.gen(function* () {
        yield* seedFragmentedDatabase({ rows: 1_000, keepEvery: 10 });
        const compaction = yield* makeDatabaseCompaction(idleOptions(dbPath));
        const freeBefore = yield* pragmaValue("freelist_count");
        const report = yield* compaction.runSteadyStateStep({ idle: false });
        assert.isFalse(report.autoVacuumIncremental);
        assert.isAbove(report.freeFractionBefore, 0.5);
        assert.equal(report.pagesReleased, 0);
        assert.equal(yield* pragmaValue("freelist_count"), freeBefore);
      }),
    ),
  );

  it.live("truncates the WAL only when idle, without waiting on readers", () =>
    withDatabase("checkpoint", (dbPath) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedFragmentedDatabase({ rows: 200, keepEvery: 1 });
        const compaction = yield* makeDatabaseCompaction(idleOptions(dbPath));
        yield* sql`UPDATE filler SET data = randomblob(4000) WHERE id <= 100`;
        assert.isAbove(fileSize(`${dbPath}-wal`), 0);

        const busy = yield* compaction.runSteadyStateStep({ idle: false });
        assert.isNull(busy.checkpoint);
        assert.isAbove(fileSize(`${dbPath}-wal`), 0);

        // A reader on another connection keeps the WAL in use: the step returns at once.
        const reader = new DatabaseSync(dbPath);
        reader.exec("BEGIN");
        reader.prepare("SELECT COUNT(*) FROM filler").get();
        try {
          const blocked = yield* compaction.runSteadyStateStep({ idle: true });
          assert.isNotNull(blocked.checkpoint);
          assert.isTrue(blocked.checkpoint?.busy);
          assert.isBelow(blocked.elapsedMs, 1_000);
          // The temporary zero busy timeout never leaks to other statements.
          assert.equal(yield* pragmaValue("busy_timeout"), 5_000);
        } finally {
          reader.exec("COMMIT");
          reader.close();
        }

        const idle = yield* compaction.runSteadyStateStep({ idle: true });
        assert.isFalse(idle.checkpoint?.busy);
        assert.equal(fileSize(`${dbPath}-wal`), 0);
        assert.equal(yield* pragmaValue("busy_timeout"), 5_000);
      }),
    ),
  );

  it.live("does nothing while the one-time rebuild runs", () =>
    withDatabase("skip", (dbPath) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedFragmentedDatabase({ rows: 1_000, keepEvery: 10 });
        yield* sql`PRAGMA busy_timeout = 300`;
        const compaction = yield* makeDatabaseCompaction(idleOptions(dbPath));
        // Hold the write lock elsewhere, so the rebuild is still waiting when the step runs.
        const other = new DatabaseSync(dbPath);
        other.exec("BEGIN IMMEDIATE");
        try {
          yield* compaction.start;
          const report = yield* compaction.runSteadyStateStep({ idle: true });
          assert.equal(report.skipped, "compaction-running");
          assert.isNull(report.checkpoint);
          yield* waitForIdle(compaction.status);
        } finally {
          other.exec("ROLLBACK");
          other.close();
        }
      }),
    ),
  );
});
