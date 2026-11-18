import * as fs from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, assert, it } from "vitest";

import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { backupDatabaseOffline, recoverRuntimeUpdateRestore } from "./runtimeUpdate.backup.ts";
import {
  estimateRuntimeUpdateDiskBudget,
  runtimeUpdateDiskRefusal,
  RUNTIME_UPDATE_MIN_RESERVE_BYTES,
} from "./runtimeUpdate.disk.ts";
import {
  ensureRuntimeUpdateDirectory,
  readRuntimeUpdateJournal,
  runtimeUpdateBackupPath,
  writeRuntimeUpdateJournal,
} from "./runtimeUpdate.journal.ts";

const cleanup: Array<string> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

const rows = (dbPath: string) => {
  const db = new DatabaseSync(dbPath);
  try {
    return db
      .prepare("SELECT id FROM acks ORDER BY id")
      .all()
      .map((row) => row.id);
  } finally {
    db.close();
  }
};

it("interrupted_restore_recovers", async () => {
  const stateDir = await fs.realpath(await fs.mkdtemp("/tmp/bb-runtime-update-"));
  cleanup.push(stateDir);
  const dbPath = join(stateDir, "state.sqlite");
  await ensureRuntimeUpdateDirectory(stateDir);
  const backupPath = runtimeUpdateBackupPath(stateDir, "op-1");
  const size = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE acks (id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO acks VALUES ('acknowledged')`;
      const bytes = yield* backupDatabaseOffline(sql, backupPath);
      yield* sql`INSERT INTO acks VALUES ('after-backup')`;
      return bytes;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath }))),
  );
  assert.isAbove(size, 0);
  assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600);
  assert.deepStrictEqual(rows(dbPath), ["acknowledged", "after-backup"]);

  const journal = {
    revision: 1 as const,
    operationId: "op-1",
    archiveKey: "2.0.0@abc",
    phase: "restore-pending" as const,
    backupPath,
    previousConfig: "config",
    previousReceipt: "receipt",
    failure: "trial failed",
    uncertain: [],
  };
  await writeRuntimeUpdateJournal(stateDir, journal);
  // A restore that died midway: a partial temp copy and a stale WAL from the trial runtime.
  await fs.writeFile(`${dbPath}.restore`, "partial");
  await fs.writeFile(`${dbPath}-wal`, "stale wal from the trial runtime");
  assert.isTrue(await recoverRuntimeUpdateRestore(stateDir, dbPath));
  assert.deepStrictEqual(rows(dbPath), ["acknowledged"]);
  assert.equal((await readRuntimeUpdateJournal(stateDir))?.phase, "restored");
  assert.isFalse(
    await fs.stat(`${dbPath}.restore`).then(
      () => true,
      () => false,
    ),
  );

  // Crash after the rename but before the journal moved on: the restore simply repeats.
  await writeRuntimeUpdateJournal(stateDir, journal);
  assert.isTrue(await recoverRuntimeUpdateRestore(stateDir, dbPath));
  assert.deepStrictEqual(rows(dbPath), ["acknowledged"]);
  // Settled: later starts leave the database alone.
  assert.isFalse(await recoverRuntimeUpdateRestore(stateDir, dbPath));
});

it("disk_budget_counts_database_wal_backup_staged_temp_and_reserve", async () => {
  const GiB = 1024 ** 3;
  const sizes: Record<string, number> = { "/s/state.sqlite": GiB, "/s/state.sqlite-wal": 0 };
  const probe = {
    fileSize: async (path: string) => sizes[path] ?? 0,
    availableBytes: async () => 3 * GiB,
  };
  const budget = await estimateRuntimeUpdateDiskBudget({
    dbPath: "/s/state.sqlite",
    stateDir: "/s",
    stagedBytes: 10,
    probe,
  });
  assert.equal(budget.reserveBytes, RUNTIME_UPDATE_MIN_RESERVE_BYTES);
  assert.equal(budget.requiredBytes, 3 * GiB + 10 + RUNTIME_UPDATE_MIN_RESERVE_BYTES);
  assert.match(runtimeUpdateDiskRefusal(budget)!, /Nothing was stopped/);
  sizes["/s/state.sqlite"] = 10 * GiB;
  const large = await estimateRuntimeUpdateDiskBudget({
    dbPath: "/s/state.sqlite",
    stateDir: "/s",
    probe: { ...probe, availableBytes: async () => 100 * GiB },
  });
  assert.equal(large.reserveBytes, 2 * GiB, "20% of database + WAL once above 256 MiB");
  assert.isNull(runtimeUpdateDiskRefusal(large));
});
