import {
  CheckpointRef,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import {
  MOBILE_SNAPSHOT_MAX_MESSAGES_PER_THREAD,
  trimOrchestrationSnapshotForMobile,
} from "./mobileSnapshot.trim";

const modelSelection: ModelSelection = {
  provider: "codex",
  model: "gpt-5.4",
};

const createdAt = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.makeUnsafe("project-mobile-trim");
const activeThreadId = ThreadId.makeUnsafe("thread-active");
const archivedThreadId = ThreadId.makeUnsafe("thread-archived");
const latestTurnId = TurnId.makeUnsafe("turn-1");
const oldTurnId = TurnId.makeUnsafe("turn-old");

function makeMessage(index: number) {
  return {
    id: MessageId.makeUnsafe(`message-${index}`),
    role: "user" as const,
    text: `message ${index}`,
    createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    updatedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    turnId: null,
    streaming: false,
  };
}

function makeActivity(
  id: string,
  kind: string,
  options?: { turnId?: TurnId; createdAt?: string },
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(id),
    kind,
    summary: id,
    tone: "info",
    payload: null,
    createdAt: options?.createdAt ?? createdAt,
    turnId: options?.turnId ?? null,
  };
}

function makeThread(overrides: Partial<OrchestrationThread> & Pick<OrchestrationThread, "id">) {
  return {
    projectId,
    title: "Thread",
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    watchingThreads: [],
    ...overrides,
  } satisfies OrchestrationThread;
}

describe("trimOrchestrationSnapshotForMobile", () => {
  it("drops archived threads and trims heavy thread fields", () => {
    const messages = Array.from({ length: MOBILE_SNAPSHOT_MAX_MESSAGES_PER_THREAD + 5 }, (_, i) =>
      makeMessage(i),
    );
    const input = {
      snapshotSequence: 1,
      updatedAt: createdAt,
      projects: [],
      threads: [
        makeThread({
          id: activeThreadId,
          title: "Active",
          latestTurn: {
            turnId: latestTurnId,
            state: "running",
            requestedAt: createdAt,
            startedAt: createdAt,
            completedAt: null,
            assistantMessageId: null,
          },
          messages,
          proposedPlans: [
            {
              id: "plan-1",
              turnId: latestTurnId,
              planMarkdown: "Plan",
              createdAt,
              updatedAt: createdAt,
              implementedAt: null,
              implementationThreadId: null,
            },
            {
              id: "plan-old",
              turnId: oldTurnId,
              planMarkdown: "Old",
              createdAt,
              updatedAt: createdAt,
              implementedAt: null,
              implementationThreadId: null,
            },
          ],
          activities: [
            makeActivity("approval-open", "approval.requested", {
              createdAt: "2026-01-01T00:00:01.000Z",
            }),
            makeActivity("tool-old", "tool.updated", { turnId: oldTurnId }),
            makeActivity("tool-current", "tool.updated", { turnId: latestTurnId }),
          ],
          checkpoints: [
            {
              turnId: latestTurnId,
              status: "ready",
              completedAt: createdAt,
              assistantMessageId: null,
              files: [],
              checkpointTurnCount: 1,
              checkpointRef: CheckpointRef.makeUnsafe("checkpoint-ref"),
            },
          ],
          watchingThreads: [{ threadId: archivedThreadId, title: "Other" }],
        }),
        makeThread({
          id: archivedThreadId,
          title: "Archived",
          archivedAt: "2026-01-02T00:00:00.000Z",
          messages: [makeMessage(0)],
        }),
      ],
    } satisfies OrchestrationReadModel;

    const snapshot = trimOrchestrationSnapshotForMobile(input);

    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]?.id).toBe(activeThreadId);
    expect(snapshot.threads[0]?.messages).toHaveLength(MOBILE_SNAPSHOT_MAX_MESSAGES_PER_THREAD);
    expect(snapshot.threads[0]?.messages.at(-1)?.text).toBe(
      `message ${MOBILE_SNAPSHOT_MAX_MESSAGES_PER_THREAD + 4}`,
    );
    expect(snapshot.threads[0]?.activities.map((activity) => activity.id)).toEqual([
      EventId.makeUnsafe("tool-current"),
      EventId.makeUnsafe("approval-open"),
    ]);
    expect(snapshot.threads[0]?.proposedPlans).toHaveLength(1);
    expect(snapshot.threads[0]?.proposedPlans[0]?.turnId).toBe(latestTurnId);
    expect(snapshot.threads[0]?.checkpoints).toEqual([]);
    expect(snapshot.threads[0]?.watchingThreads).toEqual([]);
  });
});
