/**
 * Opens a `node:sqlite` database with owner-only permissions on the database
 * directory and files. Shared by the in-process driver and the worker entry,
 * so it may only import Node built-ins.
 *
 * @module NodeSqliteClient.files
 */
import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface OpenNodeSqliteDatabaseOptions {
  readonly readonly: boolean;
  readonly allowExtension: boolean;
}

export function openNodeSqliteDatabase(
  filename: string,
  options: OpenNodeSqliteDatabaseOptions,
): DatabaseSync {
  if (filename !== ":memory:" && dirname(filename) !== ".") {
    chmodSync(dirname(filename), 0o700);
  }
  const database = new DatabaseSync(filename, {
    readOnly: options.readonly,
    allowExtension: options.allowExtension,
  });
  if (filename !== ":memory:") {
    for (const path of [filename, `${filename}-wal`, `${filename}-shm`]) {
      try {
        chmodSync(path, 0o600);
      } catch (cause) {
        if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "ENOENT") throw cause;
      }
    }
  }
  return database;
}
