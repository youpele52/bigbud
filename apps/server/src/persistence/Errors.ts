import { Schema, SchemaIssue } from "effect";

import { AutomationId } from "@bigbud/contracts";

// ===============================
// Core Persistence Errors
// ===============================

export class PersistenceSqlError extends Schema.TaggedErrorClass<PersistenceSqlError>()(
  "PersistenceSqlError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `SQL error in ${this.operation}: ${this.detail}`;
  }
}

export class PersistenceDecodeError extends Schema.TaggedErrorClass<PersistenceDecodeError>()(
  "PersistenceDecodeError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Decode error in ${this.operation}: ${this.issue}`;
  }
}

function persistenceCauseMessage(cause: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (typeof current === "object") {
      const record = current as {
        message?: unknown;
        cause?: unknown;
        reason?: { cause?: unknown; message?: unknown };
      };
      if (record.reason?.cause !== undefined && !seen.has(record.reason.cause)) {
        current = record.reason.cause;
        continue;
      }
      if (typeof record.reason?.message === "string" && record.reason.message.trim() !== "") {
        return record.reason.message;
      }
      if (record.cause !== undefined && record.cause !== current) {
        current = record.cause;
        continue;
      }
      if (
        typeof record.message === "string" &&
        record.message.trim() !== "" &&
        record.message !== "Failed to execute statement"
      ) {
        return record.message;
      }
    }
    if (current instanceof Error && current.message.trim() !== "") {
      return current.message;
    }
    break;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

export function toPersistenceSqlError(operation: string) {
  return (cause: unknown): PersistenceSqlError => {
    const causeMessage = persistenceCauseMessage(cause);
    return new PersistenceSqlError({
      operation,
      detail: causeMessage.includes("thread endpoint is deleting")
        ? "The thread is being deleted and cannot accept new related work."
        : causeMessage.includes("database is locked") || causeMessage.includes("SQLITE_BUSY")
          ? "The database is busy. Retry the action in a moment."
          : causeMessage.trim() === "" || causeMessage === `Failed to execute ${operation}`
            ? `Failed to execute ${operation}`
            : causeMessage,
      cause,
    });
  };
}

export function toPersistenceDecodeError(operation: string) {
  return (error: Schema.SchemaError): PersistenceDecodeError =>
    new PersistenceDecodeError({
      operation,
      issue: SchemaIssue.makeFormatterDefault()(error.issue),
      cause: error,
    });
}

export function toPersistenceDecodeCauseError(operation: string) {
  return (cause: unknown): PersistenceDecodeError =>
    new PersistenceDecodeError({
      operation,
      issue: `Failed to execute ${operation}`,
      cause,
    });
}

export const isPersistenceError = (u: unknown) =>
  Schema.is(PersistenceSqlError)(u) || Schema.is(PersistenceDecodeError)(u);

export class AutomationScheduleNotFoundError extends Schema.TaggedErrorClass<AutomationScheduleNotFoundError>()(
  "AutomationScheduleNotFoundError",
  {
    automationId: AutomationId,
  },
) {
  override get message(): string {
    return `Automation schedule not found: ${this.automationId}`;
  }
}

// ===============================
// Provider Session Repository Errors
// ===============================

export class ProviderSessionRepositoryValidationError extends Schema.TaggedErrorClass<ProviderSessionRepositoryValidationError>()(
  "ProviderSessionRepositoryValidationError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session repository validation failed in ${this.operation}: ${this.issue}`;
  }
}

export class ProviderSessionRepositoryPersistenceError extends Schema.TaggedErrorClass<ProviderSessionRepositoryPersistenceError>()(
  "ProviderSessionRepositoryPersistenceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Provider session repository persistence error in ${this.operation}: ${this.detail}`;
  }
}

export type OrchestrationEventStoreError = PersistenceSqlError | PersistenceDecodeError;

export type ProviderSessionRepositoryError =
  | ProviderSessionRepositoryValidationError
  | ProviderSessionRepositoryPersistenceError;

export type OrchestrationCommandReceiptRepositoryError =
  | PersistenceSqlError
  | PersistenceDecodeError;

export type ProviderSessionRuntimeRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export type ProjectionRepositoryError = PersistenceSqlError | PersistenceDecodeError;
