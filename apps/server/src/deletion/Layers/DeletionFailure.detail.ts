import { Cause } from "effect";

/** Bounds the detail stored in a durable deletion-failure activity. */
export const DELETION_FAILURE_DETAIL_MAX_LENGTH = 1_000;

const FALLBACK_DETAIL = "Thread deletion failed for an unknown reason.";

interface ErrorLike {
  readonly _tag?: unknown;
  readonly detail?: unknown;
  readonly cause?: unknown;
}

/** The innermost `Error` of a `cause` chain, e.g. the driver error inside an `SqlError`. */
function rootCause(error: object): Error | undefined {
  let root: Error | undefined;
  let current: unknown = (error as ErrorLike).cause;
  for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
    if (current instanceof Error && current.message.length > 0) root = current;
    current = (current as ErrorLike).cause;
  }
  return root;
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error === null || typeof error !== "object") return String(error);
  const record = error as ErrorLike;
  const tag = typeof record._tag === "string" ? record._tag : "";
  if (typeof record.detail === "string" && record.detail.length > 0) return record.detail;
  // Structured errors (SqlError, platform errors) render their fields into `message`; the root
  // cause carries the actionable reason, such as a violated constraint.
  const root = rootCause(error);
  if (root) return tag ? `${tag}: ${root.message}` : root.message;
  const message = error instanceof Error ? error.message : "";
  return message.length > 0 ? message : tag;
}

/**
 * Describes a failed deletion for users and logs: the first failure's own reason (its `detail` or
 * `message`), without stack frames, module paths or cause chains, and bounded in length.
 * `Cause.pretty` is unsuitable here: tagged errors carry their reason in fields, not in `message`,
 * so it rendered an empty reason followed by a stack trace.
 */
export function describeDeletionFailure(cause: Cause.Cause<unknown>): string {
  const reason = cause.reasons[0];
  if (reason === undefined) return FALLBACK_DETAIL;
  if (Cause.isFailReason(reason)) return describeDeletionError(reason.error);
  if (Cause.isDieReason(reason)) return describeDeletionError(reason.defect);
  return "Thread deletion was interrupted.";
}

/** {@link describeDeletionFailure} for one error value. */
export function describeDeletionError(error: unknown): string {
  const firstLine = errorText(error)
    .replace(/^(?:[A-Za-z]*Error: )+/, "")
    .split(/\r?\n\s+at\s/)[0]!
    .trim();
  const detail = firstLine.length > 0 ? firstLine : FALLBACK_DETAIL;
  return detail.length > DELETION_FAILURE_DETAIL_MAX_LENGTH
    ? `${detail.slice(0, DELETION_FAILURE_DETAIL_MAX_LENGTH - 1)}…`
    : detail;
}
