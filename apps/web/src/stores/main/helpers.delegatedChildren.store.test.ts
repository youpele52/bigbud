import { describe, expect, it } from "vitest";

import type { Thread } from "../../models/types";
import { syncDelegatedChildSummaries } from "./helpers.delegatedChildren.store";

function child(status: "idle" | "running"): Thread {
  return {
    id: "child" as never,
    projectId: "project" as never,
    title: "Child",
    session: {
      provider: "codex",
      status: "running",
      orchestrationStatus: status,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    },
    latestTurn: null,
    updatedAt: "2026-01-01T00:01:00.000Z",
  } as unknown as Thread;
}

describe("syncDelegatedChildSummaries", () => {
  it("refreshes a hydrated parent from live child state", () => {
    const parent = {
      id: "parent",
      delegatedChildren: [
        {
          threadId: "child",
          title: "Old child",
          projectId: null,
          workflowState: "idle",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    } as unknown as Thread;
    const result = syncDelegatedChildSummaries([parent, child("running")], child("running"));
    expect(result[0]?.delegatedChildren?.[0]).toMatchObject({
      title: "Child",
      projectId: "project",
      workflowState: "working",
      updatedAt: "2026-01-01T00:01:00.000Z",
    });
  });
});
