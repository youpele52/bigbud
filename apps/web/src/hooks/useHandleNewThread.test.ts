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
      remainingCount: 0,
    } satisfies GetStartupProjectCatalogResult;
    const getStartupProjectCatalog = vi.fn(async ({ scope }) =>
      scope === "remote" ? page : { projectionSequence: 10, projects: [], remainingCount: 0 },
    );
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
    expect(getStartupProjectCatalog.mock.calls).toEqual([
      [{ scope: "local", limit: 1, priorityProjectId: projectId }],
      [{ scope: "remote", limit: 1, priorityProjectId: projectId }],
    ]);
    expect(mergeProjectCatalogPage).toHaveBeenLastCalledWith(page);
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

  it("uses the matching scope when the other scoped lookup fails", async () => {
    let loadedProject: Project | undefined;
    const remotePage = {
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
      remainingCount: 0,
    } satisfies GetStartupProjectCatalogResult;
    const getStartupProjectCatalog = vi.fn(({ scope }) =>
      scope === "local" ? Promise.reject(new Error("local failed")) : Promise.resolve(remotePage),
    );

    await expect(
      loadProjectForNewThread({
        api: { orchestration: { getStartupProjectCatalog } } as never,
        projectId,
        getProject: () => loadedProject,
        mergeProjectCatalogPage: () => {
          loadedProject = project;
        },
      }),
    ).resolves.toBe(project);
  });

  it("merges a targeted lookup without changing catalog pagination", () => {
    const cursor = { lastUsedAt: "2026-08-10T00:00:00.000Z", projectId };
    useStore.setState({
      projects: [],
      projectCatalogCursorByScope: { local: cursor, remote: null },
    });

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
      remainingCount: 0,
    });

    expect(useStore.getState().projects[0]).toMatchObject({
      id: projectId,
      providerRuntimeExecutionTargetId: "remote-provider",
      workspaceExecutionTargetId: "remote-workspace",
    });
    expect(useStore.getState().projectCatalogCursorByScope.local).toEqual(cursor);
  });
});
