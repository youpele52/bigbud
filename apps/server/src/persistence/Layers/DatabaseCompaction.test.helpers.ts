/**
 * Synthetic file databases for the DatabaseCompaction tests: a WAL database on the SQLite worker
 * (like production) with a filler table whose deleted rows leave many free pages behind.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, Layer, type Scope } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import type { DatabaseCompactionOptions } from "./DatabaseCompaction.ts";

/** Small thresholds, so a few megabytes of free pages are enough to offer compaction. */
export const TEST_THRESHOLDS = {
  minFreeFraction: 0.25,
  minFreeBytes: 1024 * 1024,
  maxMaintenanceBacklog: 20_000,
} as const;

export const makeTempDatabase = (name: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), `bigbud-compaction-${name}-`));
  return {
    dir,
    dbPath: path.join(dir, "state.sqlite"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

/** The production write connection: WAL, busy timeout, on the worker thread. */
export const writeConnectionLayer = (dbPath: string) =>
  Layer.fresh(NodeSqliteClient.layer({ filename: dbPath, worker: true }));

export const fileSize = (filePath: string) => {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
};

/**
 * Creates the schema the compaction preconditions read and `rows` filler rows of about 4 KB,
 * then deletes all but every `keepEvery`th row, leaving most pages free.
 */
export const seedFragmentedDatabase = (input: {
  readonly rows: number;
  readonly keepEvery: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* sql`PRAGMA busy_timeout = 5000`;
    yield* sql`
      CREATE TABLE IF NOT EXISTS projection_thread_sessions (
        thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provider_name TEXT,
        provider_session_id TEXT,
        provider_thread_id TEXT,
        active_turn_id TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL
      )
    `;
    yield* sql`CREATE TABLE IF NOT EXISTS filler (id INTEGER PRIMARY KEY, data BLOB NOT NULL)`;
    yield* sql`
      WITH RECURSIVE seq(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < ${input.rows})
      INSERT INTO filler (id, data) SELECT value, randomblob(4000) FROM seq
    `;
    yield* sql`DELETE FROM filler WHERE id % ${input.keepEvery} != 0`;
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
  });

export const fillerSummary = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly count: number; readonly checksum: number }>`
    SELECT COUNT(*) AS "count", COALESCE(SUM(id), 0) AS "checksum" FROM filler
  `;
  return { count: Number(row?.count ?? 0), checksum: Number(row?.checksum ?? 0) };
});

export const pragmaValue = (pragma: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<Record<string, unknown>>(`PRAGMA ${pragma}`);
    return Number(Object.values(rows[0] ?? {})[0] ?? 0);
  });

export const idleOptions = (
  dbPath: string,
  overrides: Partial<DatabaseCompactionOptions> = {},
): DatabaseCompactionOptions => ({
  dbPath,
  thresholds: TEST_THRESHOLDS,
  readDiskFreeBytes: () => Effect.succeed(Number.MAX_SAFE_INTEGER),
  readTempDiskSpace: () => Effect.succeed({ sameVolume: true, freeBytes: null }),
  maintenanceProgress: Effect.succeed(null),
  // The tests drive the client on the worker thread, whatever runtime runs them.
  sqliteExecution: "worker",
  ...overrides,
});

/** Polls the in-memory status (real time) until the background rebuild settles. */
export const waitForIdle = <S extends { readonly state: string }>(
  status: Effect.Effect<S>,
  timeoutMs = 60_000,
): Effect.Effect<S> =>
  Effect.gen(function* () {
    const endsAt = Date.now() + timeoutMs;
    for (;;) {
      const current = yield* status;
      if (current.state === "idle") return current;
      if (Date.now() > endsAt) return yield* Effect.die(new Error("compaction did not finish"));
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
    }
  });

/** Runs `body` against a fresh WAL database on the SQLite worker, then removes it. */
export const withDatabase = <A, E>(
  name: string,
  body: (dbPath: string) => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) => {
  const database = makeTempDatabase(name);
  return body(database.dbPath).pipe(
    Effect.scoped,
    Effect.provide(writeConnectionLayer(database.dbPath)),
    Effect.ensuring(Effect.sync(database.cleanup)),
  );
};
