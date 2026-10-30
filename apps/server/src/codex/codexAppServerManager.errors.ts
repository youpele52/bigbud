import type { CodexSessionContext } from "./codexAppServerManager.types.ts";

export type CodexDeliveryCertainty = "not-dispatched" | "definite-rejection" | "possibly-applied";

/** Internal protocol failure; received mutation errors can follow a committed operation. */
export class CodexRpcError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  constructor(
    readonly method: string,
    readonly epoch: number | undefined,
    readonly delivery: CodexDeliveryCertainty,
    message: string,
    options?: {
      readonly code?: number | undefined;
      readonly data?: unknown;
      readonly cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "CodexRpcError";
    this.code = options?.code;
    this.data = sanitizeErrorData(options?.data);
  }
}

/** Only locally verified absence authorizes session-dead recovery. */
export class CodexSessionUnavailableError extends CodexRpcError {
  constructor(
    readonly reason: "missing" | "closed",
    epoch?: number,
  ) {
    super("session", epoch, "not-dispatched", `Codex session is ${reason}.`);
  }
}

function sanitizeErrorData(value: unknown, depth = 0): unknown {
  if (depth > 3) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 512);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value))
    return value.slice(0, 8).map((entry) => sanitizeErrorData(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 8)
        .map(([key, entry]) => [
          key.slice(0, 64),
          /token|secret|password|authorization|cookie|content|prompt|path/i.test(key)
            ? "[redacted]"
            : sanitizeErrorData(entry, depth + 1),
        ]),
    );
  }
  return undefined;
}

/** Numeric and string IDs occupy different namespaces within each process epoch. */
export function codexRequestKey(context: CodexSessionContext, id: string | number): string {
  return JSON.stringify([context.session.sessionEpoch ?? null, typeof id, id]);
}
