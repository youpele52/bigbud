/**
 * New databases start in incremental auto-vacuum mode (F-B8).
 *
 * SQLite only returns freed pages to the file system when `auto_vacuum` is `INCREMENTAL` (or
 * `FULL`), and that mode can be chosen freely only before the first table exists; afterwards it
 * takes a full `VACUUM`, which is the user-confirmed "Compact database" rebuild
 * (`DatabaseCompaction`). A database created by this version is therefore put in `INCREMENTAL`
 * mode before anything else touches it, and the existing bounded steady-state step
 * (`PRAGMA incremental_vacuum(1024)` once free pages exceed 10%) reclaims space from then on with
 * no rebuild.
 *
 * Existing databases keep their mode: switching them needs the full rebuild, which blocks writes
 * for its whole duration and needs free disk for a copy, so it stays user-confirmed. Backups made
 * with `VACUUM INTO` and the rebuild both work unchanged on an incremental database; a restored
 * backup in either mode is handled by the same steady-state rule.
 *
 * @module Sqlite.autoVacuum
 */
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Sets `auto_vacuum = INCREMENTAL` on an empty database file; returns whether it did. */
export const enableIncrementalAutoVacuumOnFreshDatabase = Effect.fn(
  "enableIncrementalAutoVacuumOnFreshDatabase",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly page_count: number }>`PRAGMA page_count`;
  if (Number(rows[0]?.page_count ?? 0) !== 0) return false;
  yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
  return true;
});
