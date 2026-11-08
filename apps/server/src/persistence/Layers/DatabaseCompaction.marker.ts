/**
 * A small file next to the database that exists only while a rebuild runs. `VACUUM` is atomic,
 * so a crash or restart mid-run leaves the previous database intact; the marker is how the next
 * process learns how that run ended and reports it instead of silently forgetting it.
 *
 * Reading never fails: an unreadable or malformed marker still says "a run was in progress", so
 * it is reported with whatever fields validate (an unknown outcome at worst).
 *
 * @module DatabaseCompaction.marker
 */
import { readFile, rm, stat, writeFile } from "node:fs/promises";

import {
  type DatabaseAutoVacuumMode,
  ServerDatabaseCompactionError,
} from "@bigbud/contracts/server/databaseCompaction.ts";
import { Data, Effect } from "effect";

export interface CompactionMarker {
  readonly startedAt: string;
  readonly bytesBefore: number | null;
  /** Lets the next process tell a committed rebuild (now `incremental`) from a lost one. */
  readonly autoVacuumBefore: DatabaseAutoVacuumMode | null;
}

/** A marker read back from disk; fields that did not validate are null. */
export interface RecoveredCompactionMarker {
  readonly startedAt: string | null;
  readonly bytesBefore: number | null;
  readonly autoVacuumBefore: DatabaseAutoVacuumMode | null;
  /** The marker file's mtime, a stand-in start time when `startedAt` is invalid. */
  readonly recordedAt: string | null;
}

export class CompactionMarkerError extends Data.TaggedError("CompactionMarkerError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export const compactionMarkerPath = (dbPath: string) => `${dbPath}-compaction.json`;

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;

/** A UTC ISO-8601 instant, as `Date.toISOString` writes it; anything else is null. */
export const validIsoInstant = (value: unknown): string | null =>
  typeof value === "string" && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : null;

const validByteCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

const validAutoVacuum = (value: unknown): DatabaseAutoVacuumMode | null =>
  value === "none" || value === "full" || value === "incremental" ? value : null;

export const writeCompactionMarker = (dbPath: string, marker: CompactionMarker) =>
  Effect.tryPromise({
    try: () => writeFile(compactionMarkerPath(dbPath), JSON.stringify(marker), { mode: 0o600 }),
    catch: (cause) =>
      new ServerDatabaseCompactionError({
        code: "failed",
        message: `Could not record the compaction start: ${describe(cause)}`,
      }),
  });

/** Removes the marker; fails with a readable message (EACCES, EPERM, ...), never dies. */
export const removeCompactionMarker = (dbPath: string) =>
  Effect.tryPromise({
    try: () => rm(compactionMarkerPath(dbPath), { force: true }),
    catch: (cause) =>
      new CompactionMarkerError({
        message: `Could not remove ${compactionMarkerPath(dbPath)}: ${describe(cause)}`,
        cause,
      }),
  });

export function parseCompactionMarker(
  text: string,
  recordedAt: string | null,
): RecoveredCompactionMarker {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const fields = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  return {
    startedAt: validIsoInstant(fields.startedAt),
    bytesBefore: validByteCount(fields.bytesBefore),
    autoVacuumBefore: validAutoVacuum(fields.autoVacuumBefore),
    recordedAt,
  };
}

/**
 * Reads and removes a marker left by an earlier process; null when there is none. A marker
 * that cannot be removed is logged and still reported (the next start reports it again).
 */
export const takeCompactionMarker = (dbPath: string) =>
  Effect.gen(function* () {
    const markerPath = compactionMarkerPath(dbPath);
    const read = yield* Effect.promise(async () => {
      try {
        const text = await readFile(markerPath, "utf8");
        const recordedAt = await stat(markerPath).then(
          (info) => validIsoInstant(info.mtime.toISOString()),
          () => null,
        );
        return { text, recordedAt };
      } catch {
        return null;
      }
    });
    if (read === null) return null;
    yield* removeCompactionMarker(dbPath).pipe(
      Effect.catch((error) =>
        Effect.logWarning("could not remove the compaction marker from an earlier run", {
          error: error.message,
        }),
      ),
    );
    return parseCompactionMarker(read.text, read.recordedAt);
  });
