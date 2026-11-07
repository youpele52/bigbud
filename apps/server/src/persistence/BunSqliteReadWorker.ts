/** Bun-only read worker entry. Uses the same bridge protocol and lifecycle as Node. */
import { Database, type Statement, type SQLQueryBindings } from "bun:sqlite";
import { parentPort, workerData } from "node:worker_threads";

import {
  type NodeSqliteWorkerOpenOptions,
  type NodeSqliteWorkerRequest,
  type NodeSqliteWorkerResponse,
  serializeWorkerError,
} from "./NodeSqliteWorker.protocol.ts";

// Bun exposes this method at runtime; its bundled types still omit it.
type BunStatement = Statement & { safeIntegers(enabled: boolean): void };

function startWorker(): void {
  const port = parentPort;
  if (!port) throw new Error("BunSqliteReadWorker must run inside a worker thread.");
  const post = (message: NodeSqliteWorkerResponse) => port.postMessage(message);
  const options = workerData as NodeSqliteWorkerOpenOptions;
  let db: Database;
  try {
    if (!options.readonly) throw new Error("Bun usage worker requires a read-only connection.");
    db = new Database(options.filename, { readonly: true, create: false });
  } catch (cause) {
    post({ kind: "open-failed", error: serializeWorkerError(cause) });
    port.close();
    return;
  }

  const statements = new Map<string, BunStatement>();
  const prepareCached = (sql: string): BunStatement => {
    const existing = statements.get(sql);
    if (existing) {
      statements.delete(sql);
      statements.set(sql, existing);
      return existing;
    }
    const statement = db.prepare(sql) as BunStatement;
    statements.set(sql, statement);
    if (statements.size > options.prepareCacheSize) {
      const oldest = statements.keys().next();
      if (!oldest.done) {
        statements.get(oldest.value)?.finalize();
        statements.delete(oldest.value);
      }
    }
    return statement;
  };

  port.on("message", (request: NodeSqliteWorkerRequest) => {
    if (request.kind === "close") {
      for (const statement of statements.values()) statement.finalize();
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
    let unprepared: BunStatement | undefined;
    try {
      const statement =
        request.mode === "unprepared"
          ? (unprepared = db.prepare(request.sql) as BunStatement)
          : prepareCached(request.sql);
      phase = "execute";
      statement.safeIntegers(request.safeIntegers);
      const params = request.params as SQLQueryBindings[];
      let rows: unknown;
      if (statement.columnNames.length === 0) {
        const result = statement.run(...params);
        rows = request.mode === "raw" ? result : [];
      } else {
        rows = request.mode === "values" ? statement.values(...params) : statement.all(...params);
      }
      post({ kind: "result", id: request.id, ok: true, rows: rows as unknown[] });
    } catch (cause) {
      post({
        kind: "result",
        id: request.id,
        ok: false,
        phase,
        error: serializeWorkerError(cause),
      });
    } finally {
      unprepared?.finalize();
    }
  });
  post({ kind: "ready" });
}

startWorker();
