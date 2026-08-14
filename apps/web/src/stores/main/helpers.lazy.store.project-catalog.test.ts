import { ProjectId } from "@bigbud/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { useStore } from "./main.store";
import { makeEvent } from "./main.store.test.helpers";

const projectId = ProjectId.makeUnsafe("project-1");

function makePage(
  projectionSequence: number,
  title = "Catalog project",
  deletingAt: string | null = null,
) {
  return {
    projectionSequence,
    projects: [
      {
        id: projectId,
        title,
        providerRuntimeExecutionTargetId: "local",
        workspaceExecutionTargetId: "local",
        executionTargetId: "local",
        workspaceRoot: "/tmp/project-1",
        lastUsedAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
        deletingAt,
        threadCount: 0,
        exceptionalThreadCount: 0,
        hasExceptionalThreads: false,
      },
    ],
    remainingCount: 0,
  } as const;
}

const emptySidebarCatalog = {
  projectionSequence: 0,
  threads: [],
  recentThreadIds: [],
  pinnedThreadIds: [],
  projectThreadCounts: [],
} as const;

beforeEach(() => {
  useStore.setState({
    projects: [],
    projectCatalogCursorByScope: { local: null, remote: null },
    projectCatalogLoadingByScope: { local: false, remote: false },
    projectCatalogErrorByScope: { local: undefined, remote: undefined },
    projectCatalogRetryHeadByScope: { local: false, remote: false },
    projectCatalogRestartProjectIdByScope: { local: null, remote: null },
    latestProjectEventSequenceById: {},
    deletedProjectSequenceById: {},
    pendingUnloadedProjectPatchById: {},
    projectThreadCountsById: {},
  });
});

describe("lazy project catalog pages", () => {
  it("does not resurrect a project deleted after a stale page snapshot", () => {
    useStore
      .getState()
      .applyOrchestrationEvent(
        makeEvent(
          "project.deleted",
          { projectId, deletedAt: "2026-08-10T00:00:01.000Z" },
          { sequence: 20 },
        ),
      );

    useStore.getState().appendProjectCatalogPage("local", makePage(19));

    expect(useStore.getState().projects).toEqual([]);
  });

  it("does not resurrect a deleted project during stale bounded recovery", () => {
    useStore
      .getState()
      .applyOrchestrationEvent(
        makeEvent(
          "project.deleted",
          { projectId, deletedAt: "2026-08-10T00:00:01.000Z" },
          { sequence: 20 },
        ),
      );

    useStore.getState().syncBoundedCatalog(
      {
        local: makePage(19),
        remote: { projectionSequence: 19, projects: [], remainingCount: 0 },
      },
      {},
      {},
      emptySidebarCatalog,
      [],
    );

    expect(useStore.getState().projects).toEqual([]);
  });

  it("does not overwrite newer project metadata with an older page", () => {
    useStore.getState().appendProjectCatalogPage("local", makePage(10));
    useStore
      .getState()
      .applyOrchestrationEvent(
        makeEvent(
          "project.meta-updated",
          { projectId, title: "Newer title", updatedAt: "2026-08-10T00:00:01.000Z" },
          { sequence: 20 },
        ),
      );

    useStore.getState().appendProjectCatalogPage("local", makePage(19, "Stale title"));

    expect(useStore.getState().projects[0]?.name).toBe("Newer title");
  });

  it("keeps loaded projects protected after deletion-requested", () => {
    useStore.getState().appendProjectCatalogPage("local", makePage(10, "Current title"));
    useStore
      .getState()
      .applyOrchestrationEvent(
        makeEvent(
          "project.deletion-requested",
          { projectId, deletingAt: "2026-08-10T00:00:01.000Z" },
          { sequence: 20 },
        ),
      );

    useStore.getState().appendProjectCatalogPage("local", makePage(19, "Stale title"));

    expect(useStore.getState().latestProjectEventSequenceById?.[projectId]).toBe(20);
    expect(useStore.getState().projects[0]?.name).toBe("Current title");
  });

  it("keeps loaded projects protected after deletion-failed", () => {
    useStore.getState().appendProjectCatalogPage("local", makePage(10, "Current title"));
    useStore
      .getState()
      .applyOrchestrationEvent(
        makeEvent(
          "project.deletion-failed",
          { projectId, updatedAt: "2026-08-10T00:00:01.000Z" },
          { sequence: 20 },
        ),
      );

    useStore.getState().appendProjectCatalogPage("local", makePage(19, "Stale title"));

    expect(useStore.getState().latestProjectEventSequenceById?.[projectId]).toBe(20);
    expect(useStore.getState().projects[0]?.name).toBe("Current title");
  });

  it("merges newer unloaded metadata into a stale catalog row", () => {
    useStore
      .getState()
      .applyOrchestrationEvent(
        makeEvent(
          "project.meta-updated",
          { projectId, title: "Newer title", updatedAt: "2026-08-10T00:00:01.000Z" },
          { sequence: 20 },
        ),
      );
    useStore.getState().appendProjectCatalogPage("local", makePage(19));

    expect(useStore.getState().projects).toHaveLength(1);
    expect(useStore.getState().projects[0]).toMatchObject({
      name: "Newer title",
      updatedAt: "2026-08-10T00:00:01.000Z",
    });
    expect(useStore.getState().pendingUnloadedProjectPatchById?.[projectId]).toBeUndefined();
  });

  it("merges newer unloaded metadata during stale bounded recovery", () => {
    useStore
      .getState()
      .applyOrchestrationEvent(
        makeEvent(
          "project.meta-updated",
          { projectId, title: "Newer title", updatedAt: "2026-08-10T00:00:01.000Z" },
          { sequence: 20 },
        ),
      );

    useStore.getState().syncBoundedCatalog(
      {
        local: makePage(19),
        remote: { projectionSequence: 19, projects: [], remainingCount: 0 },
      },
      {},
      {},
      emptySidebarCatalog,
      [],
    );

    expect(useStore.getState().projects[0]).toMatchObject({
      name: "Newer title",
      updatedAt: "2026-08-10T00:00:01.000Z",
    });
    expect(useStore.getState().pendingUnloadedProjectPatchById?.[projectId]).toBeUndefined();
  });

  it("retains a newer loaded project omitted from a stale bounded recovery page", () => {
    useStore.getState().appendProjectCatalogPage("local", makePage(10));
    useStore
      .getState()
      .applyOrchestrationEvent(
        makeEvent(
          "project.meta-updated",
          { projectId, title: "Newer title", updatedAt: "2026-08-10T00:00:01.000Z" },
          { sequence: 20 },
        ),
      );

    useStore.getState().syncBoundedCatalog(
      {
        local: { ...makePage(19), projects: [] },
        remote: { projectionSequence: 19, projects: [], remainingCount: 0 },
      },
      {},
      {},
      emptySidebarCatalog,
      [],
    );

    expect(useStore.getState().projects[0]).toMatchObject({
      id: projectId,
      name: "Newer title",
      updatedAt: "2026-08-10T00:00:01.000Z",
    });
  });

  it("merges a newer unloaded deletion request into a stale catalog row", () => {
    useStore
      .getState()
      .applyOrchestrationEvent(
        makeEvent(
          "project.deletion-requested",
          { projectId, deletingAt: "2026-08-10T00:00:01.000Z" },
          { sequence: 20 },
        ),
      );

    useStore.getState().appendProjectCatalogPage("local", makePage(19));

    expect(useStore.getState().projects[0]).toMatchObject({
      deletingAt: "2026-08-10T00:00:01.000Z",
      updatedAt: "2026-08-10T00:00:01.000Z",
    });
  });

  it("merges a newer unloaded deletion failure into a stale deleting catalog row", () => {
    useStore
      .getState()
      .applyOrchestrationEvent(
        makeEvent(
          "project.deletion-failed",
          { projectId, updatedAt: "2026-08-10T00:00:02.000Z" },
          { sequence: 20 },
        ),
      );

    useStore
      .getState()
      .appendProjectCatalogPage(
        "local",
        makePage(19, "Catalog project", "2026-08-10T00:00:00.000Z"),
      );

    expect(useStore.getState().projects[0]).toMatchObject({
      deletingAt: null,
      updatedAt: "2026-08-10T00:00:02.000Z",
    });
  });
});
