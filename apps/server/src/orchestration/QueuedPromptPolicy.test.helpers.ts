import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationTurnControlOperation,
} from "@bigbud/contracts";

export const now = "2026-08-01T00:00:00.000Z";
export const threadId = ThreadId.makeUnsafe("thread-policy");
export const turnId = TurnId.makeUnsafe("turn-policy");
export const prompt = (id: string) => ({ id: MessageId.makeUnsafe(id), text: id, createdAt: now });
export function operation(
  overrides: Partial<OrchestrationTurnControlOperation> = {},
): OrchestrationTurnControlOperation {
  return {
    operationId: CommandId.makeUnsafe("control"),
    action: "steer",
    reservedPromptIds: [prompt("one").id],
    sessionEpoch: 1,
    expectedTurnId: turnId,
    strategy: "pending-selection",
    state: "requested",
    requestedAt: now,
    updatedAt: now,
    ...overrides,
  };
}
export function thread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.makeUnsafe("project"),
    title: "Queue policy",
    elevatorSummary: null,
    elevatorSummaryMessageCount: 0,
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    queuedPrompts: [prompt("one"), prompt("two")],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    pinnedAt: null,
    deletingAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    tasks: [],
    activities: [],
    checkpoints: [],
    watchingThreads: [],
    session: {
      threadId,
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: turnId,
      sessionEpoch: 1,
      lastError: null,
      updatedAt: now,
    },
    ...overrides,
  };
}
export function model(value: OrchestrationThread): OrchestrationReadModel {
  return { snapshotSequence: 0, projects: [], threads: [value], updatedAt: now };
}
