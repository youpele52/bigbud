import { DEFAULT_MODEL_BY_PROVIDER, ProjectId, ThreadId } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvent } from "./events.store";
import { type AppState } from "./main.store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "../../models/types";
import { makeEvent, makeState, makeThread } from "./main.store.test.helpers";

describe("incremental orchestration updates", () => {
  it("updates the existing project title when project.meta-updated arrives", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const state = makeState(makeThread({ projectId }));

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.meta-updated", {
        projectId,
        title: "Renamed Project",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projects[0]?.name).toBe("Renamed Project");
    expect(next.projects[0]?.updatedAt).toBe("2026-02-27T00:00:01.000Z");
  });

  it("returns the same state reference when project.meta-updated targets an unknown projectId", () => {
    const state = makeState(makeThread());

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.meta-updated", {
        projectId: ProjectId.makeUnsafe("project-missing"),
        title: "Ghost Project",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next).toBe(state);
  });

  it("applies a partial project.meta-updated (workspaceRoot only) while preserving other fields", () => {
    const state = makeState(makeThread());
    const originalName = state.projects[0]?.name;

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.meta-updated", {
        projectId: ProjectId.makeUnsafe("project-1"),
        workspaceRoot: "/tmp/new-root",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projects[0]?.cwd).toBe("/tmp/new-root");
    expect(next.projects[0]?.name).toBe(originalName);
    expect(next.projects[0]?.updatedAt).toBe("2026-02-27T00:00:01.000Z");
  });

  it("does not create a new state reference for an unrelated project when project.meta-updated targets a different project", () => {
    const projectId1 = ProjectId.makeUnsafe("project-1");
    const projectId2 = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
      projects: [
        {
          id: projectId1,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
        {
          id: projectId2,
          name: "Project 2",
          cwd: "/tmp/project-2",
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
      bootstrapComplete: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.meta-updated", {
        projectId: projectId1,
        title: "Project 1 Renamed",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    // Only project-1 changes — project-2's object reference must be preserved.
    expect(next.projects[1]).toBe(state.projects[1]);
    expect(next.projects[0]?.name).toBe("Project 1 Renamed");
  });

  it("preserves state identity for no-op project and thread deletes", () => {
    const thread = makeThread();
    const state = makeState(thread);

    const nextAfterProjectDelete = applyOrchestrationEvent(
      state,
      makeEvent("project.deleted", {
        projectId: ProjectId.makeUnsafe("project-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );
    const nextAfterThreadDelete = applyOrchestrationEvent(
      state,
      makeEvent("thread.deleted", {
        threadId: ThreadId.makeUnsafe("thread-missing"),
        deletedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(nextAfterProjectDelete).toBe(state);
    expect(nextAfterThreadDelete).toBe(state);
  });

  it("reuses an existing project row when project.created arrives with a new id for the same cwd", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project",
          cwd: "/tmp/project",
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
      bootstrapComplete: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: recreatedProjectId,
        title: "Project Recreated",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projects).toHaveLength(1);
    expect(next.projects[0]?.id).toBe(recreatedProjectId);
    expect(next.projects[0]?.cwd).toBe("/tmp/project");
    expect(next.projects[0]?.name).toBe("Project Recreated");
  });

  it("keeps local and remote projects distinct when they share the same cwd", () => {
    const localProjectId = ProjectId.makeUnsafe("project-local");
    const remoteProjectId = ProjectId.makeUnsafe("project-remote");
    const state: AppState = {
      projects: [
        {
          id: localProjectId,
          name: "Project",
          executionTargetId: "local",
          cwd: "/tmp/project",
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
      bootstrapComplete: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("project.created", {
        projectId: remoteProjectId,
        title: "Project Remote",
        executionTargetId: "ssh:devbox",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        scripts: [],
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.projects).toHaveLength(2);
    expect(next.projects.find((project) => project.id === localProjectId)?.executionTargetId).toBe(
      "local",
    );
    expect(next.projects.find((project) => project.id === remoteProjectId)?.executionTargetId).toBe(
      "ssh:devbox",
    );
  });

  it("removes stale project index entries when thread.created recreates a thread under a new project", () => {
    const originalProjectId = ProjectId.makeUnsafe("project-1");
    const recreatedProjectId = ProjectId.makeUnsafe("project-2");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const thread = makeThread({
      id: threadId,
      projectId: originalProjectId,
    });
    const state: AppState = {
      projects: [
        {
          id: originalProjectId,
          name: "Project 1",
          cwd: "/tmp/project-1",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
        {
          id: recreatedProjectId,
          name: "Project 2",
          cwd: "/tmp/project-2",
          defaultModelSelection: {
            provider: "codex",
            model: DEFAULT_MODEL_BY_PROVIDER.codex,
          },
          scripts: [],
        },
      ],
      threads: [thread],
      sidebarThreadsById: {},
      threadIdsByProjectId: {
        [originalProjectId]: [threadId],
      },
      bootstrapComplete: true,
    };

    const next = applyOrchestrationEvent(
      state,
      makeEvent("thread.created", {
        threadId,
        projectId: recreatedProjectId,
        title: "Recovered thread",
        modelSelection: {
          provider: "codex",
          model: DEFAULT_MODEL_BY_PROVIDER.codex,
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: "2026-02-27T00:00:01.000Z",
        updatedAt: "2026-02-27T00:00:01.000Z",
      }),
    );

    expect(next.threads).toHaveLength(1);
    expect(next.threads[0]?.projectId).toBe(recreatedProjectId);
    expect(next.threadIdsByProjectId[originalProjectId]).toBeUndefined();
    expect(next.threadIdsByProjectId[recreatedProjectId]).toEqual([threadId]);
  });
});
