import { ProjectId, type GetStartupProjectCatalogResult } from "@bigbud/contracts";
import { describe, expect, it, vi } from "vitest";

import type { Project } from "../models/types";
import { useStore } from "../stores/main";
import { loadProjectForNewThread } from "./useHandleNewThread";

const projectId = ProjectId.makeUnsafe("project-1");
const project: Project = {
  id: projectId,
  name: "Project 1",
  providerRuntimeExecutionTargetId: "remote-provider",
  workspaceExecutionTargetId: "remote-workspace",
  executionTargetId: "remote-workspace",
  cwd: "/workspace",
  defaultModelSelection: null,
  scripts: [],
};

describe("loadProjectForNewThread", () => {
  it("loads an omitted project with authoritative execution targets", async () => {
    let loadedProject: Project | undefined;
    const page = {
      projectionSequence: 10,
      projects: [
        {
          id: projectId,
          title: "Project 1",
          providerRuntimeExecutionTargetId: "remote-provider",
          workspaceExecutionTargetId: "remote-workspace",
          executionTargetId: "remote-workspace",
          workspaceRoot: "/workspace",
          lastUsedAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:00.000Z",
          deletingAt: null,
          threadCount: 0,
          exceptionalThreadCount: 0,
          hasExceptionalThreads: false,
        },
      ],
    } satisfies GetStartupProjectCatalogResult;
    const getStartupProjectCatalog = vi.fn(async () => page);
    const mergeProjectCatalogPage = vi.fn(() => {
      loadedProject = project;
    });

    await expect(
      loadProjectForNewThread({
        api: { orchestration: { getStartupProjectCatalog } } as never,
        projectId,
        getProject: () => loadedProject,
        mergeProjectCatalogPage,
      }),
    ).resolves.toBe(project);
    expect(getStartupProjectCatalog).toHaveBeenCalledWith({
      limit: 1,
      priorityProjectId: projectId,
    });
    expect(mergeProjectCatalogPage).toHaveBeenCalledWith(page);
  });

  it("reuses a project already loaded by the bounded catalog", async () => {
    const getStartupProjectCatalog = vi.fn();

    await expect(
      loadProjectForNewThread({
        api: { orchestration: { getStartupProjectCatalog } } as never,
        projectId,
        getProject: () => project,
        mergeProjectCatalogPage: vi.fn(),
      }),
    ).resolves.toBe(project);
    expect(getStartupProjectCatalog).not.toHaveBeenCalled();
  });

  it("merges a targeted lookup without changing catalog pagination", () => {
    const cursor = { lastUsedAt: "2026-08-10T00:00:00.000Z", projectId };
    useStore.setState({ projects: [], projectCatalogCursor: cursor });

    useStore.getState().mergeProjectCatalogPage({
      projectionSequence: 10,
      projects: [
        {
          id: projectId,
          title: "Project 1",
          providerRuntimeExecutionTargetId: "remote-provider",
          workspaceExecutionTargetId: "remote-workspace",
          executionTargetId: "remote-workspace",
          workspaceRoot: "/workspace",
          lastUsedAt: "2026-08-11T00:00:00.000Z",
          updatedAt: "2026-08-11T00:00:00.000Z",
          deletingAt: null,
          threadCount: 0,
          exceptionalThreadCount: 0,
          hasExceptionalThreads: false,
        },
      ],
    });

    expect(useStore.getState().projects[0]).toMatchObject({
      id: projectId,
      providerRuntimeExecutionTargetId: "remote-provider",
      workspaceExecutionTargetId: "remote-workspace",
    });
    expect(useStore.getState().projectCatalogCursor).toEqual(cursor);
  });
});
