/**
 * Where the operational SQLite connection runs. The rebuild is only safe on the Node worker
 * thread: on an in-process connection `VACUUM` runs on the backend's event loop and freezes every
 * request, WebSocket and timer for its whole duration (minutes on a large file).
 *
 * Mirrors the selection in `Layers/Sqlite.ts` and `NodeSqliteClient.ts` (`shouldUseWorker` and
 * the missing-entry fallback) without changing them:
 *
 * - Bun uses `@effect/sql-sqlite-bun`, always in-process (`bun dev`);
 * - Node opts the operational connection into the worker, unless `BIGBUD_SQLITE_WORKER` is `0`
 *   or `false`, or the worker entry is not shipped beside the client (it then falls back to the
 *   main thread with a warning).
 *
 * @module DatabaseCompaction.execution
 */
import process from "node:process";

import { resolveNodeSqliteWorkerEntry } from "../NodeSqliteClient.worker.ts";

export type SqliteExecution = "worker" | "in-process";

export interface SqliteExecutionEnvironment {
  readonly isBun: boolean;
  readonly workerMode: string | undefined;
  readonly workerEntry: string | undefined;
}

export const currentSqliteExecutionEnvironment = (): SqliteExecutionEnvironment => ({
  isBun: process.versions.bun !== undefined,
  workerMode: process.env.BIGBUD_SQLITE_WORKER,
  workerEntry: resolveNodeSqliteWorkerEntry(),
});

/** Pure: where the production write connection (`worker: true`) ends up running. */
export function detectSqliteExecution(
  environment: SqliteExecutionEnvironment = currentSqliteExecutionEnvironment(),
): SqliteExecution {
  if (environment.isBun) return "in-process";
  const mode = environment.workerMode?.trim().toLowerCase();
  if (mode === "0" || mode === "false") return "in-process";
  return environment.workerEntry === undefined ? "in-process" : "worker";
}
