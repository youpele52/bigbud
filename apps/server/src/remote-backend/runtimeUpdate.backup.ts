/**
 * Offline database backup and restore for runtime activation (M3 WP-4D).
 *
 * The backup runs after drain, with public admission closed, through the compaction module's
 * reserved-connection `execute` helper: `VACUUM INTO` writes a consistent, compacted copy of the
 * live database (WAL included) without blocking readers. It is written to a temp name and
 * renamed, so a partial file is never mistaken for a backup.
 *
 * Restore happens only before the database is opened (`recoverRuntimeUpdateRestore`): copy to a
 * temp name, fsync, drop the WAL/SHM sidecars, rename over the database, fsync. Every step can
 * repeat, so a restore interrupted at any point completes on the next start.
 */
import * as fs from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { execute } from "../persistence/Layers/DatabaseCompaction.vacuum.ts";
import {
  readRuntimeUpdateJournal,
  replacePrivateFile,
  syncDirectory,
  writeRuntimeUpdateJournal,
} from "./runtimeUpdate.journal.ts";

const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

export const backupDatabaseOffline = Effect.fn("RuntimeUpdate.backupDatabaseOffline")(function* (
  sql: SqlClient.SqlClient,
  target: string,
) {
  const temporary = join(dirname(target), `.${basename(target)}.partial`);
  yield* Effect.promise(() => fs.rm(temporary, { force: true }));
  yield* Effect.scoped(
    Effect.flatMap(sql.reserve, (connection) =>
      execute(connection, `VACUUM INTO ${sqlString(temporary)}`),
    ),
  );
  yield* Effect.promise(async () => {
    const handle = await fs.open(temporary, "r+");
    try {
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, target);
    await syncDirectory(dirname(target));
  });
  return (yield* Effect.promise(() => fs.stat(target))).size;
});

/** Replaces the (closed) database with the backup. Idempotent; never touches the backup. */
export async function restoreDatabaseBackup(dbPath: string, backupPath: string) {
  const bytes = await fs.readFile(backupPath);
  await replacePrivateFile(`${dbPath}.restore`, bytes, dirname(dbPath));
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) await fs.rm(sidecar, { force: true });
  await fs.rename(`${dbPath}.restore`, dbPath);
  await syncDirectory(dirname(dbPath));
}

/**
 * Startup hook, run before the database opens: completes a pending (or interrupted) rollback
 * restore. Returns whether a restore ran.
 */
export async function recoverRuntimeUpdateRestore(stateDir: string, dbPath: string) {
  const journal = await readRuntimeUpdateJournal(stateDir);
  if (journal?.phase !== "restore-pending") return false;
  await restoreDatabaseBackup(dbPath, journal.backupPath);
  await writeRuntimeUpdateJournal(stateDir, { ...journal, phase: "restored" });
  return true;
}
