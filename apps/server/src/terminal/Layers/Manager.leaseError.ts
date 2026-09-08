import type { TerminalRuntimeLeaseReason } from "@bigbud/contracts/workspace/terminal.ts";

const MAX_CAUSE_NODES = 24;
const MAX_MESSAGE_LENGTH = 1_024;
const MAX_FALLBACK_LENGTH = 4_096;

function classifyStringCode(code: string): TerminalRuntimeLeaseReason | null {
  const normalized = code.toUpperCase();
  if (normalized === "ENOSPC" || normalized === "SQLITE_FULL") return "storageFull";
  if (
    normalized === "SQLITE_BUSY" ||
    normalized.startsWith("SQLITE_BUSY_") ||
    normalized === "SQLITE_LOCKED" ||
    normalized.startsWith("SQLITE_LOCKED_")
  ) {
    return "databaseBusy";
  }
  if (normalized === "SQLITE_CONSTRAINT" || normalized.startsWith("SQLITE_CONSTRAINT_")) {
    return "conflict";
  }
  return null;
}

function classifySqlitePrimaryCode(code: number): TerminalRuntimeLeaseReason | null {
  switch (Math.trunc(code) & 0xff) {
    case 5:
    case 6:
      return "databaseBusy";
    case 13:
      return "storageFull";
    case 19:
      return "conflict";
    default:
      return null;
  }
}

function classifyStructuredCause(cause: unknown): {
  readonly reason: TerminalRuntimeLeaseReason | null;
  readonly messages: string[];
} {
  const pending = [cause];
  const seen = new Set<object>();
  const messages: string[] = [];
  let visited = 0;

  while (pending.length > 0 && visited < MAX_CAUSE_NODES) {
    const current = pending.shift();
    visited += 1;
    if (typeof current === "string") {
      messages.push(current.slice(0, MAX_MESSAGE_LENGTH));
      continue;
    }
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);

    const record = current as Record<string, unknown>;
    if (record._tag === "LockTimeoutError") return { reason: "databaseBusy", messages };
    if (record._tag === "ConstraintError") return { reason: "conflict", messages };

    if (typeof record.code === "string") {
      const reason = classifyStringCode(record.code);
      if (reason) return { reason, messages };
    } else if (typeof record.code === "number") {
      const reason = classifySqlitePrimaryCode(record.code);
      if (reason) return { reason, messages };
    }
    if (typeof record.errno === "number") {
      if (record.errno === 28) return { reason: "storageFull", messages };
      const reason = classifySqlitePrimaryCode(record.errno);
      if (reason) return { reason, messages };
    }
    if (typeof record.message === "string") {
      messages.push(record.message.slice(0, MAX_MESSAGE_LENGTH));
    }
    pending.push(record.reason, record.cause);
  }

  return { reason: null, messages };
}

export function classifyTerminalRuntimeLeaseError(cause: unknown): TerminalRuntimeLeaseReason {
  const structured = classifyStructuredCause(cause);
  if (structured.reason) return structured.reason;

  const text = structured.messages.join("\n").slice(0, MAX_FALLBACK_LENGTH).toLowerCase();
  if (
    text.includes("sqlite_full") ||
    text.includes("database or disk is full") ||
    text.includes("no space left on device") ||
    text.includes("enospc")
  ) {
    return "storageFull";
  }
  if (
    text.includes("sqlite_busy") ||
    text.includes("sqlite_locked") ||
    text.includes("database is locked") ||
    text.includes("database table is locked")
  ) {
    return "databaseBusy";
  }
  if (
    text.includes("sqlite_constraint") ||
    text.includes("constraint failed") ||
    text.includes("constraint violation")
  ) {
    return "conflict";
  }
  return "unknown";
}
