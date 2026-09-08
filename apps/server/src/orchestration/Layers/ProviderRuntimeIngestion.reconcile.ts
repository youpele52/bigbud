import {
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThread,
  type ProviderSession,
} from "@bigbud/contracts";
import { Cause, Effect, Schema } from "effect";

import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";

import {
  DEFAULT_RUNTIME_MODE,
  mapProviderSessionStatusToOrchestrationStatus,
  serverCommandId,
} from "./ProviderCommandReactorHelpers.ts";
import {
  PROVIDER_CHECKING_SESSION_REASON,
  PROVIDER_LOST_SESSION_REASON,
  PROVIDER_RECOVERING_SESSION_REASON,
  PROVIDER_STALLED_SESSION_REASON,
} from "@bigbud/contracts/constants/providerRuntime.constant";

const PROVIDER_HEALTH_REASONS = new Set<string>([
  PROVIDER_CHECKING_SESSION_REASON,
  PROVIDER_LOST_SESSION_REASON,
  PROVIDER_RECOVERING_SESSION_REASON,
  PROVIDER_STALLED_SESSION_REASON,
]);

/**
 * Dispatches one reconciliation command without allowing an unrelated thread
 * failure to abort the rest of the reconciliation batch.
 */
export function dispatchReconciliationCommandSafely(
  orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">,
  command: OrchestrationCommand,
): Effect.Effect<"applied" | "retryable" | "terminal", OrchestrationDispatchError> {
  return orchestrationEngine.dispatch(command).pipe(
    Effect.as("applied" as const),
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      const failure = Cause.findErrorOption(cause);
      if (failure._tag === "Some" && isDeletingParentReconciliationError(failure.value)) {
        return Effect.logDebug("provider runtime reconciliation reached terminal deletion fence", {
          commandId: command.commandId,
          commandType: command.type,
          ...(command.type === "thread.session.set" ? { threadId: command.threadId } : {}),
        }).pipe(Effect.as("terminal" as const));
      }
      return Effect.logWarning("provider runtime reconciliation command failed", {
        commandId: command.commandId,
        commandType: command.type,
        ...("threadId" in command ? { threadId: command.threadId } : {}),
        cause: Cause.pretty(cause),
      }).pipe(Effect.as("retryable" as const));
    }),
  );
}

export function isDeletingParentReconciliationError(error: unknown): boolean {
  return Schema.is(PersistenceSqlError)(error) && error.detail === "parent thread is deleting";
}

function areSessionsEqual(
  left: OrchestrationThread["session"],
  right: OrchestrationSession,
): boolean {
  return (
    left?.threadId === right.threadId &&
    left?.status === right.status &&
    left?.providerName === right.providerName &&
    left?.runtimeMode === right.runtimeMode &&
    left?.activeTurnId === right.activeTurnId &&
    (left?.sessionEpoch ?? 0) === (right.sessionEpoch ?? 0) &&
    (left.reason ?? null) === (right.reason ?? null) &&
    left?.lastError === right.lastError &&
    left?.updatedAt === right.updatedAt
  );
}

function toReconciledSession(input: {
  thread: OrchestrationThread;
  liveSession: ProviderSession | undefined;
  occurredAt: string;
}): OrchestrationSession | null {
  const { thread, liveSession, occurredAt } = input;
  const currentSession = thread.session;

  if (liveSession) {
    if (
      liveSession.sessionEpoch !== undefined &&
      liveSession.sessionEpoch !== (currentSession?.sessionEpoch ?? 0)
    ) {
      return null;
    }
    const status = mapProviderSessionStatusToOrchestrationStatus(liveSession.status);
    const currentReason = currentSession?.reason ?? null;
    const preserveSupervisorState =
      currentSession !== null &&
      currentSession !== undefined &&
      currentSession.activeTurnId === liveSession.activeTurnId &&
      PROVIDER_HEALTH_REASONS.has(currentReason ?? "");
    const healLegacyChecking =
      preserveSupervisorState &&
      currentReason === PROVIDER_CHECKING_SESSION_REASON &&
      status === "running";
    const nextSession: OrchestrationSession = {
      threadId: thread.id,
      status: preserveSupervisorState && !healLegacyChecking ? currentSession.status : status,
      providerName: liveSession.provider,
      runtimeMode: thread.runtimeMode ?? liveSession.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      activeTurnId: liveSession.activeTurnId ?? null,
      sessionEpoch: currentSession?.sessionEpoch ?? liveSession.sessionEpoch ?? 0,
      reason: healLegacyChecking
        ? null
        : preserveSupervisorState
          ? currentReason
          : status === "running" || status === "starting"
            ? currentReason
            : null,
      lastError: healLegacyChecking
        ? null
        : preserveSupervisorState
          ? currentSession.lastError
          : (liveSession.lastError ??
            (status === "error" ? (currentSession?.lastError ?? null) : null)),
      updatedAt: liveSession.updatedAt,
    };
    return areSessionsEqual(currentSession, nextSession) ? null : nextSession;
  }

  if (!currentSession) {
    return null;
  }

  const nextSession: OrchestrationSession = {
    threadId: thread.id,
    status: "stopped",
    providerName: currentSession.providerName,
    runtimeMode: thread.runtimeMode ?? currentSession.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    activeTurnId: null,
    sessionEpoch: currentSession.sessionEpoch ?? 0,
    reason: null,
    lastError: currentSession.lastError,
    updatedAt: occurredAt,
  };
  return areSessionsEqual(currentSession, nextSession) ? null : nextSession;
}

export function buildThreadReconciliationCommand(input: {
  thread: OrchestrationThread;
  liveSession: ProviderSession | undefined;
  occurredAt: string;
}): OrchestrationCommand | null {
  const nextSession = toReconciledSession(input);
  if (!nextSession) return null;

  return {
    type: "thread.session.set",
    commandId: serverCommandId("provider-runtime-session-reconcile"),
    threadId: input.thread.id,
    session: nextSession,
    expectedSessionEpoch: input.thread.session?.sessionEpoch ?? 0,
    ...(input.thread.session?.activeTurnId
      ? { expectedActiveTurnId: input.thread.session.activeTurnId }
      : {}),
    createdAt: input.occurredAt,
  };
}

export const STARTUP_STALE_DELETE_RETRY_LIMIT = 25;

export function buildStartupReconciliationCommands(input: {
  threads: ReadonlyArray<OrchestrationThread>;
  liveSessions: ReadonlyArray<ProviderSession>;
  occurredAt: string;
}): ReadonlyArray<OrchestrationCommand> {
  const liveSessionByThreadId = new Map(
    input.liveSessions.map((session) => [session.threadId, session]),
  );
  const commands: OrchestrationCommand[] = [];
  let staleDeleteRetries = 0;

  for (const thread of input.threads) {
    if (thread.deletedAt !== null) {
      continue;
    }

    if (thread.deletingAt !== null) {
      if (staleDeleteRetries >= STARTUP_STALE_DELETE_RETRY_LIMIT) {
        continue;
      }
      staleDeleteRetries += 1;
      commands.push({
        type: "thread.delete",
        commandId: serverCommandId("provider-runtime-stale-thread-delete-retry"),
        threadId: thread.id,
      });
      continue;
    }

    const command = buildThreadReconciliationCommand({
      thread,
      liveSession: liveSessionByThreadId.get(thread.id),
      occurredAt: input.occurredAt,
    });
    if (!command) {
      continue;
    }
    commands.push(command);
  }

  return commands;
}
