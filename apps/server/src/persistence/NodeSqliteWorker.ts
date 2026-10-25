/**
 * Worker-thread entry that owns the single `node:sqlite` connection. The main
 * thread sends one statement per message; messages are handled synchronously
 * in arrival order, so statement order, transactions and WAL behaviour match
 * the in-process driver while the main event loop stays free.
 *
 * Runs from `dist/NodeSqliteWorker.mjs` in builds and from this file under
 * Node type stripping in tests, so it may only import Node built-ins and
 * type-only or erasable sibling modules.
 *
 * @module NodeSqliteWorker
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import { openNodeSqliteDatabase } from "./NodeSqliteClient.files.ts";
import {
  type NodeSqliteWorkerOpenOptions,
  type NodeSqliteWorkerRequest,
  type NodeSqliteWorkerResponse,
  serializeWorkerError,
} from "./NodeSqliteWorker.protocol.ts";

function startWorker(): void {
  const port = parentPort;
  if (!port) throw new Error("NodeSqliteWorker must run inside a worker thread.");
  const post = (message: NodeSqliteWorkerResponse) => port.postMessage(message);
  const options = workerData as NodeSqliteWorkerOpenOptions;

  let db: DatabaseSync;
  try {
    db = openNodeSqliteDatabase(options.filename, options);
  } catch (cause) {
    post({ kind: "open-failed", error: serializeWorkerError(cause) });
    port.close();
    return;
  }

  // Insertion-ordered map as an LRU of prepared statements.
  const statements = new Map<string, StatementSync>();
  const readers = new WeakMap<StatementSync, boolean>();
  const hasRows = (statement: StatementSync): boolean => {
    const cached = readers.get(statement);
    if (cached !== undefined) return cached;
    const value = statement.columns().length > 0;
    readers.set(statement, value);
    return value;
  };
  const prepareCached = (sql: string): StatementSync => {
    const existing = statements.get(sql);
    if (existing) {
      statements.delete(sql);
      statements.set(sql, existing);
      return existing;
    }
    const statement = db.prepare(sql);
    statements.set(sql, statement);
    if (statements.size > options.prepareCacheSize) {
      const oldest = statements.keys().next();
      if (!oldest.done) statements.delete(oldest.value);
    }
    return statement;
  };

  const execute = (
    statement: StatementSync,
    request: Extract<NodeSqliteWorkerRequest, { kind: "execute" }>,
  ): unknown[] => {
    const params = request.params as Parameters<StatementSync["all"]>;
    statement.setReadBigInts(request.safeIntegers);
    if (!hasRows(statement)) {
      const result = statement.run(...params);
      return request.mode === "raw" ? (result as unknown as unknown[]) : [];
    }
    if (request.mode !== "values") return statement.all(...params);
    statement.setReturnArrays(true);
    try {
      return statement.all(...params);
    } finally {
      statement.setReturnArrays(false);
    }
  };

  port.on("message", (request: NodeSqliteWorkerRequest) => {
    if (request.kind === "close") {
      statements.clear();
      try {
        db.close();
      } finally {
        post({ kind: "result", id: request.id, ok: true, rows: [] });
        port.close();
      }
      return;
    }
    let phase: "prepare" | "execute" = "prepare";
    try {
      const statement =
        request.mode === "unprepared" ? db.prepare(request.sql) : prepareCached(request.sql);
      phase = "execute";
      post({ kind: "result", id: request.id, ok: true, rows: execute(statement, request) });
    } catch (cause) {
      post({
        kind: "result",
        id: request.id,
        ok: false,
        phase,
        error: serializeWorkerError(cause),
      });
    }
  });
  post({ kind: "ready" });
}

startWorker();
