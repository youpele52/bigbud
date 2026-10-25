/**
 * Message protocol between the main-thread SQLite bridge and the
 * `node:sqlite` worker. Kept free of runtime dependencies and non-erasable
 * TypeScript so the worker entry can run from source under Node type stripping.
 *
 * @module NodeSqliteWorker.protocol
 */

export interface NodeSqliteWorkerOpenOptions {
  readonly filename: string;
  readonly readonly: boolean;
  readonly allowExtension: boolean;
  readonly prepareCacheSize: number;
}

/** How the worker runs one statement. Mirrors the `Connection` methods of the Effect SQL client. */
export type NodeSqliteWorkerExecuteMode = "rows" | "raw" | "values" | "unprepared";

export type NodeSqliteWorkerRequest =
  | {
      readonly kind: "execute";
      readonly id: number;
      readonly sql: string;
      readonly params: ReadonlyArray<unknown>;
      readonly mode: NodeSqliteWorkerExecuteMode;
      readonly safeIntegers: boolean;
    }
  | { readonly kind: "close"; readonly id: number };

/** Serialized SQLite failure. Keeps the fields `classifySqliteError` reads. */
export interface NodeSqliteWorkerError {
  readonly message: string;
  readonly name?: string | undefined;
  readonly code?: string | number | undefined;
  readonly errno?: number | undefined;
  readonly errcode?: number | undefined;
  readonly errstr?: string | undefined;
  readonly stack?: string | undefined;
}

export type NodeSqliteWorkerResponse =
  | { readonly kind: "ready" }
  | { readonly kind: "open-failed"; readonly error: NodeSqliteWorkerError }
  | {
      readonly kind: "result";
      readonly id: number;
      readonly ok: true;
      readonly rows: ReadonlyArray<unknown>;
    }
  | {
      readonly kind: "result";
      readonly id: number;
      readonly ok: false;
      readonly phase: "prepare" | "execute";
      readonly error: NodeSqliteWorkerError;
    };

export function serializeWorkerError(cause: unknown): NodeSqliteWorkerError {
  if (typeof cause !== "object" || cause === null) {
    return { message: String(cause) };
  }
  const record = cause as Record<string, unknown>;
  const pick = <T>(key: string, type: "string" | "number"): T | undefined =>
    typeof record[key] === type ? (record[key] as T) : undefined;
  const code = record.code;
  return {
    message: pick<string>("message", "string") ?? String(cause),
    name: pick<string>("name", "string"),
    code: typeof code === "string" || typeof code === "number" ? code : undefined,
    errno: pick<number>("errno", "number"),
    errcode: pick<number>("errcode", "number"),
    errstr: pick<string>("errstr", "string"),
    stack: pick<string>("stack", "string"),
  };
}

/** Rebuilds an `Error` carrying the original SQLite fields, so error classification is unchanged. */
export function deserializeWorkerError(error: NodeSqliteWorkerError): Error {
  const rebuilt = new Error(error.message) as Error & Record<string, unknown>;
  if (error.name !== undefined) rebuilt.name = error.name;
  if (error.stack !== undefined) rebuilt.stack = error.stack;
  for (const key of ["code", "errno", "errcode", "errstr"] as const) {
    if (error[key] !== undefined) rebuilt[key] = error[key];
  }
  return rebuilt;
}
