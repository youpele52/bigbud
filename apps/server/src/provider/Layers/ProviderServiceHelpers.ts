/**
 * Pure top-level helpers for ProviderService.
 *
 * Extracted from ProviderService.ts to keep that file under 500 lines.
 * No Effect services are required here — all functions are pure or use
 * only schema decoding.
 */
import { ModelSelection, NonNegativeInt, ThreadId } from "@bigbud/contracts";
import { Effect, Schema, SchemaIssue } from "effect";

import { ProviderValidationError } from "../Errors.ts";
import { resolveProviderSessionExecutionTargets } from "../providerSessionExecutionTargets.ts";
import type { ProviderRuntimeBinding } from "../Services/ProviderSessionDirectory.ts";

export const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

export function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

export const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

export function toRuntimeStatus(session: {
  status: string;
}): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

export function toRuntimePayloadFromSession(
  session: {
    providerRuntimeExecutionTargetId?: string | null | undefined;
    workspaceExecutionTargetId?: string | null | undefined;
    executionTargetId?: string | null | undefined;
    cwd?: string | null | undefined;
    model?: string | null | undefined;
    activeTurnId?: string | null | undefined;
    lastError?: string | null | undefined;
  },
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  const executionTargets = resolveProviderSessionExecutionTargets({
    providerRuntimeExecutionTargetId: session.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: session.workspaceExecutionTargetId,
    executionTargetId: session.executionTargetId,
  });
  return {
    providerRuntimeExecutionTargetId: executionTargets.providerRuntimeExecutionTargetId,
    workspaceExecutionTargetId: executionTargets.workspaceExecutionTargetId,
    executionTargetId: executionTargets.executionTargetId,
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

export function readPersistedModelSelection(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return Schema.is(ModelSelection)(raw) ? raw : undefined;
}

export function readPersistedCwd(
  runtimePayload: ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
