import {
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThread,
  type ProviderSession,
} from "@bigbud/contracts";

import {
  DEFAULT_RUNTIME_MODE,
  mapProviderSessionStatusToOrchestrationStatus,
  serverCommandId,
} from "./ProviderCommandReactorHelpers.ts";

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
    const status = mapProviderSessionStatusToOrchestrationStatus(liveSession.status);
    const nextSession: OrchestrationSession = {
      threadId: thread.id,
      status,
      providerName: liveSession.provider,
      runtimeMode: thread.runtimeMode ?? liveSession.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      activeTurnId: liveSession.activeTurnId ?? null,
      reason:
        status === "running" || status === "starting" ? (currentSession?.reason ?? null) : null,
      lastError:
        liveSession.lastError ?? (status === "error" ? (currentSession?.lastError ?? null) : null),
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
    createdAt: input.occurredAt,
  };
}

export function buildStartupReconciliationCommands(input: {
  threads: ReadonlyArray<OrchestrationThread>;
  liveSessions: ReadonlyArray<ProviderSession>;
  deletionOwnedThreadIds?: ReadonlySet<string>;
  occurredAt: string;
}): ReadonlyArray<OrchestrationCommand> {
  const liveSessionByThreadId = new Map(
    input.liveSessions.map((session) => [session.threadId, session]),
  );
  const commands: OrchestrationCommand[] = [];

  for (const thread of input.threads) {
    if (thread.deletedAt !== null) {
      continue;
    }

    if (thread.deletingAt !== null) {
      if (input.deletionOwnedThreadIds?.has(thread.id)) {
        continue;
      }
      commands.push({
        type: "thread.delete.abort",
        commandId: serverCommandId("provider-runtime-stale-thread-delete-abort"),
        threadId: thread.id,
        createdAt: input.occurredAt,
      });
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
