import type { ProjectSummary } from "@bigbud/contracts/orchestration/orchestration.catalog";
import { describe, expect, it } from "vitest";

import { toProjectSearchResults } from "./SearchPalette.projectResults";

function project(id: string, title: string, deletingAt: string | null = null): ProjectSummary {
  return {
    id: id as ProjectSummary["id"],
    title,
    providerRuntimeExecutionTargetId: "local",
    workspaceExecutionTargetId: "local",
    executionTargetId: "local",
    workspaceRoot: `/workspaces/${id}`,
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletingAt,
    threadCount: 0,
    exceptionalThreadCount: 0,
    hasExceptionalThreads: false,
  };
}

describe("toProjectSearchResults", () => {
  it("keeps independent local and remote project matches while excluding deleting projects", () => {
    const results = toProjectSearchResults({
      localProjects: [project("local-project", "Local project")],
      remoteProjects: [
        project("remote-project", "Remote project"),
        project("deleting-project", "Deleting project", "2026-01-02T00:00:00.000Z"),
      ],
    });

    expect(results.map((result) => [result.project.title, result.scope])).toEqual([
      ["Local project", "local"],
      ["Remote project", "remote"],
    ]);
  });
});
