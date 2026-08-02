import { ProjectId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import { describe, expect, it } from "vitest";

import {
  getRemainingSidebarThreadCount,
  indexActiveSidebarThreadIdsByProject,
} from "./sidebarThreadCount.logic";

const projectId = ProjectId.makeUnsafe("project-counts");

function thread(
  id: string,
  overrides: Partial<{
    archivedAt: string | null;
    deletingAt: string | null;
    purpose: "standard" | "side-chat";
  }> = {},
) {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId,
    purpose: "standard" as const,
    archivedAt: null,
    deletingAt: null,
    ...overrides,
  };
}

describe("authoritative sidebar thread counts", () => {
  it("subtracts the rendered preview from the authoritative active total", () => {
    expect(
      getRemainingSidebarThreadCount({
        authoritativeActiveThreadCount: 94,
        representedThreadIds: Array.from({ length: 4 }, (_, index) => `preview-${index}`),
      }),
    ).toBe(90);
  });

  it("subtracts unique loaded active summaries from the authoritative total", () => {
    expect(
      getRemainingSidebarThreadCount({
        authoritativeActiveThreadCount: 94,
        representedThreadIds: Array.from({ length: 61 }, (_, index) => `loaded-${index}`),
      }),
    ).toBe(33);
  });

  it("accounts for an active thread added outside the first four preview entries", () => {
    expect(
      getRemainingSidebarThreadCount({
        authoritativeActiveThreadCount: 94,
        representedThreadIds: ["first", "second", "third", "fourth", "active"],
      }),
    ).toBe(89);
  });

  it("clamps contradictory totals and leaves unavailable totals unlabeled", () => {
    expect(
      getRemainingSidebarThreadCount({
        authoritativeActiveThreadCount: 4,
        representedThreadIds: [1, 2, 3, 4, 5],
      }),
    ).toBe(0);
    expect(
      getRemainingSidebarThreadCount({
        authoritativeActiveThreadCount: undefined,
        representedThreadIds: [1, 2, 3, 4],
      }),
    ).toBeNull();
  });

  it("deduplicates loaded membership and excludes archived, deleting, and side-chat summaries", () => {
    const active = thread("active");
    const indexed = indexActiveSidebarThreadIdsByProject([
      active,
      active,
      thread("archived", { archivedAt: "2026-08-01" }),
      thread("deleting", { deletingAt: "2026-08-01" }),
      thread("side-chat", { purpose: "side-chat" }),
    ]);

    expect([...indexed.get(projectId)!]).toEqual([active.id]);
  });
});
