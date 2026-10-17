import { ProjectId, ThreadId } from "@bigbud/contracts";
import { it as effectIt } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import {
  type ProjectionThread,
  ProjectionThreadRepository,
} from "../persistence/Services/ProjectionThreads.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { projectEvent } from "./projector.ts";
import { makeEvent } from "./projector.test.helpers.ts";
import { createEmptyReadModel } from "./projectorReadModel.ts";

const NOW = "2026-10-15T10:00:00.000Z";
const forkOrigin = {
  forkPointMessageId: "assistant-9",
  reason: "recovery-failed",
  failureEventId: "turn-start-failed:evt-1",
} as const;

const created = (pendingDelivery?: "sent" | "held") =>
  makeEvent({
    sequence: 1,
    type: "thread.created",
    aggregateKind: "thread",
    aggregateId: "fork-1",
    occurredAt: NOW,
    commandId: "cmd-fork",
    payload: {
      threadId: "fork-1",
      projectId: "project-1",
      title: "Long running work",
      modelSelection: { provider: "codex", model: "gpt-5-codex" },
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      parentThread: { threadId: "source-1", title: "Long running work", projectId: "project-1" },
      forkOrigin: { ...forkOrigin, ...(pendingDelivery ? { pendingDelivery } : {}) },
      createdAt: NOW,
      updatedAt: NOW,
    },
  });

describe("fork lineage projection", () => {
  it("keeps fork lineage and holds the queue when the pending message is held", async () => {
    const held = await Effect.runPromise(projectEvent(createEmptyReadModel(NOW), created("held")));
    expect(held.threads[0]?.forkOrigin).toEqual({ ...forkOrigin, pendingDelivery: "held" });
    expect(held.threads[0]?.queueHold).toBe(true);
    const sent = await Effect.runPromise(projectEvent(createEmptyReadModel(NOW), created("sent")));
    expect(sent.threads[0]?.queueHold).toBe(false);
  });
});

const persisted: ProjectionThread = {
  threadId: ThreadId.makeUnsafe("fork-1"),
  projectId: ProjectId.makeUnsafe("project-1"),
  title: "Long running work",
  purpose: "standard",
  elevatorSummary: "Long running work",
  elevatorSummaryMessageCount: 0,
  providerRuntimeExecutionTargetId: "local",
  workspaceExecutionTargetId: "local",
  executionTargetId: "local",
  modelSelection: { provider: "codex", model: "gpt-5-codex" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  parentThread: {
    threadId: ThreadId.makeUnsafe("source-1"),
    title: "Long running work",
    projectId: ProjectId.makeUnsafe("project-1"),
  },
  forkOrigin: forkOrigin as never,
  latestTurnId: null,
  queuedPrompts: [],
  createdAt: NOW,
  updatedAt: NOW,
  lastActivityAt: NOW,
  archivedAt: null,
  pinnedAt: null,
  deletingAt: null,
  deletedAt: null,
};

effectIt.layer(
  Layer.mergeAll(OrchestrationProjectionSnapshotQueryLive, ProjectionThreadRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
)("fork lineage persistence", (it) => {
  it.effect("survives later upserts and reaches the snapshot", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      yield* repository.upsert(persisted);
      // A later upsert from a row read without lineage must not erase it.
      const { forkOrigin: _omitted, ...withoutLineage } = persisted;
      yield* repository.upsert({ ...withoutLineage, title: "Renamed", updatedAt: NOW });
      const row = yield* repository.getById({ threadId: persisted.threadId });
      expect(Option.isSome(row)).toBe(true);
      const snapshot = yield* (yield* ProjectionSnapshotQuery).getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.id === persisted.threadId);
      expect(thread?.title).toBe("Renamed");
      expect(thread?.forkOrigin).toEqual(forkOrigin);
      expect(thread?.parentThread?.threadId).toBe("source-1");
    }),
  );
});
