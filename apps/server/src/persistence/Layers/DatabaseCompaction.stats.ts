/**
 * Reads what database compaction decides on: page counts and `auto_vacuum` from SQLite, file
 * sizes and free disk from the filesystem, and running turns from the projections.
 *
 * @module DatabaseCompaction.stats
 */
import { stat, statfs } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { Effect } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type DatabasePageStats,
  type TempDiskSpace,
  toAutoVacuumMode,
} from "./DatabaseCompaction.policy.ts";

const pragmaNumber = (sql: SqlClient.SqlClient, pragma: string) =>
  sql
    .unsafe<Record<string, unknown>>(`PRAGMA ${pragma}`)
    .pipe(Effect.map((rows) => Number(Object.values(rows[0] ?? {})[0] ?? 0)));

export const readPageStats = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const pageSize = yield* pragmaNumber(sql, "page_size");
    const pageCount = yield* pragmaNumber(sql, "page_count");
    const freelistCount = yield* pragmaNumber(sql, "freelist_count");
    const autoVacuum = yield* pragmaNumber(sql, "auto_vacuum");
    return {
      pageSize,
      pageCount,
      freelistCount,
      autoVacuum: toAutoVacuumMode(autoVacuum),
    } satisfies DatabasePageStats;
  });

const fileBytes = (filePath: string) =>
  Effect.promise(() =>
    stat(filePath).then(
      (info) => info.size,
      () => 0,
    ),
  );

export const readFileSizes = (dbPath: string) =>
  Effect.all({ fileBytes: fileBytes(dbPath), walBytes: fileBytes(`${dbPath}-wal`) });

/** Free bytes available to this user on the volume holding `dbPath`; null when unreadable. */
export const readDiskFreeBytes = (dbPath: string) =>
  Effect.promise(() =>
    statfs(path.dirname(dbPath)).then(
      (info) => Number(info.bavail) * Number(info.bsize),
      () => null,
    ),
  );

/** SQLite's unix temp-directory search order (`unixTempFileDir`), after `PRAGMA temp_store_directory`. */
export const sqliteTempDirCandidates = (env: NodeJS.ProcessEnv = process.env) =>
  [env.SQLITE_TMPDIR, env.TMPDIR, "/var/tmp", "/usr/tmp", "/tmp", "."].filter(
    (dir): dir is string => typeof dir === "string" && dir.length > 0,
  );

const deviceOf = (dir: string) =>
  stat(dir).then(
    (info) => (info.isDirectory() ? info.dev : null),
    () => null,
  );

/**
 * Free space where `VACUUM` writes its temp copy: the first existing temp directory SQLite
 * would pick. Unreadable counts as unknown, which blocks the rebuild rather than risking it.
 */
export const readTempDiskSpace = (dbPath: string) =>
  Effect.promise(async (): Promise<TempDiskSpace> => {
    const databaseDevice = await deviceOf(path.dirname(dbPath));
    for (const dir of sqliteTempDirCandidates()) {
      const device = await deviceOf(dir);
      if (device === null) continue;
      if (databaseDevice !== null && device === databaseDevice) {
        return { sameVolume: true, freeBytes: null };
      }
      const freeBytes = await statfs(dir).then(
        (info) => Number(info.bavail) * Number(info.bsize),
        () => null,
      );
      return { sameVolume: false, freeBytes };
    }
    return { sameVolume: false, freeBytes: null };
  });

/** Turns in progress, by the same rule background maintenance uses. Unreadable means busy. */
export const readRunningTurns = (sql: SqlClient.SqlClient) =>
  sql<{ readonly count: number }>`
    SELECT COUNT(*) AS "count" FROM projection_thread_sessions
    WHERE active_turn_id IS NOT NULL AND status IN ('starting', 'running')
  `.pipe(
    Effect.map((rows) => Number(rows[0]?.count ?? 0)),
    Effect.catch(() => Effect.succeed(Number.MAX_SAFE_INTEGER)),
  );
