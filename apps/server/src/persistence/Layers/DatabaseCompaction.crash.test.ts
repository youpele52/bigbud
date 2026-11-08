import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeDatabaseCompaction } from "./DatabaseCompaction.ts";
import { compactionMarkerPath } from "./DatabaseCompaction.marker.ts";
import {
  fileSize,
  fillerSummary,
  idleOptions,
  makeTempDatabase,
  pragmaValue,
  seedFragmentedDatabase,
  waitForIdle,
  writeConnectionLayer,
} from "./DatabaseCompaction.test.helpers.ts";

/** The same statements as the rebuild, in a process the test can kill. */
const VACUUM_SCRIPT = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.BIGBUD_TEST_DB);
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA auto_vacuum = INCREMENTAL");
process.stdout.write("start\\n");
db.exec("VACUUM");
process.stdout.write("done\\n");
`;

/** Starts `VACUUM` in a child process and SIGKILLs it once the rebuild is writing the WAL. */
const killMidVacuum = (dbPath: string) =>
  new Promise<{ readonly finished: boolean; readonly walBytesAtKill: number }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["--no-warnings", "-e", VACUUM_SCRIPT], {
        env: { ...process.env, BIGBUD_TEST_DB: dbPath },
        stdio: ["ignore", "pipe", "inherit"],
      });
      let output = "";
      let walBytesAtKill = 0;
      const timer = setInterval(() => {
        const wal = fileSize(`${dbPath}-wal`);
        if (output.includes("start") && wal > 512 * 1024 && walBytesAtKill === 0) {
          walBytesAtKill = wal;
          child.kill("SIGKILL");
        }
      }, 1);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.on("error", reject);
      child.on("exit", () => {
        clearInterval(timer);
        resolve({ finished: output.includes("done"), walBytesAtKill });
      });
    },
  );

it.live.skipIf(process.versions.bun !== undefined)(
  "a backend killed mid-VACUUM leaves the old database intact and reports the run as interrupted",
  () => {
    const database = makeTempDatabase("crash");
    const { dbPath } = database;
    return Effect.gen(function* () {
      const before = yield* seedFragmentedDatabase({ rows: 12_000, keepEvery: 3 }).pipe(
        Effect.andThen(fillerSummary),
        Effect.provide(writeConnectionLayer(dbPath)),
      );
      const sizeBefore = fileSize(dbPath);
      // What the rebuild records before it starts.
      writeFileSync(
        compactionMarkerPath(dbPath),
        JSON.stringify({
          startedAt: "2026-11-07T10:00:00.000Z",
          bytesBefore: sizeBefore,
          autoVacuumBefore: "none",
        }),
      );

      const crash = yield* Effect.promise(() => killMidVacuum(dbPath));
      assert.isFalse(crash.finished, "the child finished VACUUM before it could be killed");
      assert.isAbove(crash.walBytesAtKill, 0);

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [integrity] = yield* sql<{ readonly integrity_check: string }>`
            PRAGMA integrity_check
          `;
        assert.equal(integrity?.integrity_check, "ok");
        assert.equal(yield* pragmaValue("auto_vacuum"), 0);
        assert.deepEqual(yield* fillerSummary, before);

        const compaction = yield* makeDatabaseCompaction(idleOptions(dbPath));
        const recovered = (yield* compaction.status).lastRun;
        assert.equal(recovered?.outcome, "interrupted");
        assert.equal(recovered?.bytesBefore, sizeBefore);
        const preview = yield* compaction.preview;
        assert.deepEqual(preview.blockers, []);

        // The next run starts cleanly and completes.
        yield* compaction.start;
        const finished = yield* waitForIdle(compaction.status);
        assert.equal(finished.lastRun?.outcome, "completed");
        assert.isBelow(fileSize(dbPath), sizeBefore * 0.5);
        assert.equal(yield* pragmaValue("auto_vacuum"), 2);
        assert.deepEqual(yield* fillerSummary, before);
      }).pipe(Effect.scoped, Effect.provide(writeConnectionLayer(dbPath)));
    }).pipe(Effect.ensuring(Effect.sync(database.cleanup)));
  },
  60_000,
);
