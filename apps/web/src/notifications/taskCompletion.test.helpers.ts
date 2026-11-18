import { RuntimeTaskId } from "@bigbud/contracts/core/baseSchemas";
import type { OrchestrationEvent } from "@bigbud/contracts/orchestration/orchestration.events.ts";
import type { Thread } from "../models/types";

export const now = "2026-11-11T10:00:00.000Z";

export function makeNotificationThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "thread-1" as never,
    codexThreadId: null,
    projectId: "project-1" as never,
    title: "Current task",
    modelSelection: { provider: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    turnDiffSummaries: [],
    error: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: "turn-1" as never,
      state: "completed",
      terminalOutcome: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    },
    notificationObservation: { messages: [], settledTurnId: "turn-1", settledSessionEpoch: 0 },
    notificationSafety: {
      turnId: "turn-1" as never,
      tasks: [],
      childThreadIds: [],
      pendingRequestIds: [],
      queuedPromptIds: [],
      overflow: false,
    },
    ...overrides,
  };
}

type Agent = NonNullable<Thread["providerAgents"]>[number];

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: RuntimeTaskId.makeUnsafe("agent-1"),
    kind: "providerSubagent" as const,
    turnId: "turn-1" as never,
    status: "inProgress" as const,
    subject: "Owned work",
    source: "lifecycle" as const,
    freshness: { sessionEpoch: "epoch-1", sourcePriority: 1, observedOrdinal: 1 },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function notificationEvent(type: string, payload: unknown): OrchestrationEvent {
  return { type, payload, occurredAt: now, sequence: 1 } as OrchestrationEvent;
}
