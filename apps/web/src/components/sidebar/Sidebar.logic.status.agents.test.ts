import type { OrchestrationTask } from "@bigbud/contracts";
import { describe, expect, it } from "vitest";

import { resolveThreadStatusPill } from "./Sidebar.logic.status";

const providerAgent = {
  status: "inProgress",
  activityFresh: true,
} as unknown as OrchestrationTask;

function thread(orchestrationStatus: "idle" | "running", activityFresh = true) {
  return {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    latestTurn: null,
    providerAgents: [{ ...providerAgent, activityFresh }],
    session: {
      provider: "codex" as const,
      status: "running" as const,
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
      orchestrationStatus,
    },
  };
}

describe("sidebar provider-agent activity", () => {
  it("uses fresh child activity only when the main thread is idle", () => {
    expect(resolveThreadStatusPill({ thread: thread("idle") })).toMatchObject({
      label: "Subagents Working",
      colorClass: "text-info-foreground",
      dotClass: "bg-info-foreground",
      pulse: true,
    });
    expect(resolveThreadStatusPill({ thread: thread("running") })).toMatchObject({
      label: "Working",
    });
    expect(resolveThreadStatusPill({ thread: thread("idle", false) })).not.toMatchObject({
      label: "Subagents Working",
    });
  });
});
