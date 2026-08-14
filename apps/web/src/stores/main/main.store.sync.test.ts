import {
  DEFAULT_MODEL_BY_PROVIDER,
  ProjectId,
  ThreadId,
  type ThreadSummary,
  type OrchestrationReadModel,
} from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { syncBoundedCatalog } from "./helpers.lazy.store";
import { syncServerReadModel } from "./helpers.snapshot.store";
import { type AppState } from "./main.store";
import { buildSidebarThreadSummary } from "./mappers.store";
import {
  makeReadModel,
  makeReadModelProject,
  makeReadModelThread,
  makeState,
  makeThread,
} from "./main.store.test.helpers";

describe("store read model sync", () => {
  it("marks bootstrap complete after snapshot sync", () => {
    const initialState: AppState = {
      ...makeState(makeThread()),
      bootstrapComplete: false,
    };

    const next = syncServerReadModel(initialState, makeReadModel(makeReadModelThread({})));

    expect(next.bootstrapComplete).toBe(true);
  });

  it("preserves claude model slugs without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("opus");
  });

  it("resolves claude aliases when session provider is claudeAgent", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "claudeAgent",
          model: "sonnet",
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.modelSelection.model).toBe("default");
  });

  it("preserves cursor as the active session provider", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        modelSelection: {
          provider: "cursor",
          model: "kimi-k2.5",
        },
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "cursor",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-27T00:00:00.000Z",
        },
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.session?.provider).toBe("cursor");
  });

  it("preserves project and thread updatedAt timestamps from the read model", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        updatedAt: "2026-02-27T00:05:00.000Z",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects[0]?.updatedAt).toBe("2026-02-27T00:00:00.000Z");
    expect(next.threads[0]?.updatedAt).toBe("2026-02-27T00:05:00.000Z");
  });

  it("maps archivedAt from the read model", () => {
    const initialState = makeState(makeThread());
    const archivedAt = "2026-02-28T00:00:00.000Z";
    const next = syncServerReadModel(
      initialState,
      makeReadModel(
        makeReadModelThread({
          archivedAt,
        }),
      ),
    );

    expect(next.threads[0]?.archivedAt).toBe(archivedAt);
  });

  it("keeps Sidecar threads out of normal sidebar indexes", () => {
    const initialState = makeState(makeThread());
    const sideChat = makeReadModelThread({ purpose: "side-chat" });

    const next = syncServerReadModel(initialState, makeReadModel(sideChat));

    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.purpose).toBe("side-chat");
    expect(next.sidebarThreadsById[sideChat.id]).toBeUndefined();
    expect(next.threadIdsByProjectId[sideChat.projectId]).toBeUndefined();
  });

  it("replaces projects using snapshot order during recovery", () => {
    const project1 = ProjectId.makeUnsafe("project-1");
    const project2 = ProjectId.makeUnsafe("project-2");
    const project3 = ProjectId.makeUnsafe("project-3");
    const initialState: AppState = {
      projects: [
        {
          id: project2,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
        {
          id: project1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [],
      sidebarThreadsById: {},
      threadIdsByProjectId: {},
      threadSummaryCursorByProjectId: {},
      sidebarRecentThreadIds: [],
      sidebarPinnedThreadIds: [],
      bootstrapComplete: true,
      projectCatalogCursorByScope: { local: null, remote: null },
      projectCatalogRemainingCountByScope: { local: null, remote: null },
      projectCatalogGenerationByScope: { local: 0, remote: 0 },
      projectCatalogLoadingByScope: { local: false, remote: false },
      projectCatalogErrorByScope: { local: undefined, remote: undefined },
      projectCatalogRetryHeadByScope: { local: false, remote: false },
      projectCatalogRestartProjectIdByScope: { local: null, remote: null },
      threadHydrationById: {},
    };
    const readModel: OrchestrationReadModel = {
      snapshotSequence: 2,
      updatedAt: "2026-02-27T00:00:00.000Z",
      projects: [
        makeReadModelProject({
          id: project1,
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
        }),
        makeReadModelProject({
          id: project2,
          title: "Project 2",
          workspaceRoot: "/tmp/project-2",
        }),
        makeReadModelProject({
          id: project3,
          title: "Project 3",
          workspaceRoot: "/tmp/project-3",
        }),
      ],
      threads: [],
    };

    const next = syncServerReadModel(initialState, readModel);

    expect(next.projects.map((project) => project.id)).toEqual([project1, project2, project3]);
  });

  it("preserves richer hydrated fields while reconciling a bounded summary", () => {
    const threadId = ThreadId.makeUnsafe("hydrated-thread");
    const turnId = "turn-completed" as never;
    const latestTurn = {
      turnId,
      state: "completed" as const,
      requestedAt: "2026-02-27T00:00:00.000Z",
      startedAt: "2026-02-27T00:00:01.000Z",
      completedAt: "2026-02-27T00:01:00.000Z",
      assistantMessageId: null,
    };
    const session = {
      provider: "codex" as const,
      status: "error" as const,
      orchestrationStatus: "error" as const,
      createdAt: "2026-02-27T00:00:00.000Z",
      updatedAt: "2026-02-27T00:01:00.000Z",
      lastError: "Keep the hydrated error",
    };
    const thread = makeThread({
      id: threadId,
      latestTurn,
      session,
      error: "Keep the hydrated error",
      elevatorSummaryMessageCount: 7,
    });
    const summary: ThreadSummary = {
      id: threadId,
      projectId: thread.projectId,
      title: "Updated summary title",
      purpose: "standard",
      elevatorSummary: "Updated summary",
      modelSelection: thread.modelSelection,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      providerRuntimeExecutionTargetId: "local",
      workspaceExecutionTargetId: "local",
      executionTargetId: "local",
      branch: null,
      worktreePath: null,
      createdAt: thread.createdAt,
      updatedAt: "2026-02-27T00:02:00.000Z",
      latestUserMessageAt: null,
      pinnedAt: null,
      sessionStatus: "ready",
      providerName: "codex",
      activeTurnId: null,
      latestTurnState: "completed",
      isWatching: false,
      isWatched: false,
      isDelegated: false,
      isAwaitingApproval: false,
    };
    const initialState: AppState = {
      ...makeState(thread),
      sidebarThreadsById: { [threadId]: buildSidebarThreadSummary(thread) },
    };

    const next = syncBoundedCatalog(
      initialState,
      {
        local: { projectionSequence: 1, projects: [], remainingCount: 0 },
        remote: { projectionSequence: 1, projects: [], remainingCount: 0 },
      },
      {},
      {},
      { projectionSequence: 1, threads: [summary], recentThreadIds: [], pinnedThreadIds: [] },
      [],
    );

    expect(next.threads[0]).toMatchObject({
      title: "Updated summary title",
      latestTurn,
      session,
      error: "Keep the hydrated error",
      elevatorSummaryMessageCount: 7,
    });
    expect(next.sidebarThreadsById[threadId]).toMatchObject({
      title: "Updated summary title",
      latestTurn,
      session,
      elevatorSummaryMessageCount: 7,
    });
  });
});
