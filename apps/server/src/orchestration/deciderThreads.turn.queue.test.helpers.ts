import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
} from "@bigbud/contracts";

/** One idle thread for queue decider tests; override any thread field. */
export const now = "2026-08-01T00:00:00.000Z";
export const threadId = ThreadId.makeUnsafe("thread-queue");

export function readModel(overrides: Partial<OrchestrationReadModel["threads"][number]> = {}) {
  return {
    snapshotSequence: 0,
    projects: [],
    updatedAt: now,
    threads: [
      {
        id: threadId,
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "Queue",
        elevatorSummary: null,
        elevatorSummaryMessageCount: 0,
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        latestTurn: null,
        queuedPrompts: [],
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
        session: null,
        watchingThreads: [],
        ...overrides,
      },
    ],
  } satisfies OrchestrationReadModel;
}
