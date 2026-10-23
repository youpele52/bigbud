import { describe, expect, it } from "vitest";

import { resolveThreadStatusPill } from "./Sidebar.logic";

const erroredAfterSleepCut = {
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  interactionMode: "default" as const,
  latestTurn: null,
  session: {
    provider: "claudeAgent" as const,
    status: "error" as const,
    createdAt: "2026-10-22T10:00:00.000Z",
    updatedAt: "2026-10-22T10:10:00.000Z",
    orchestrationStatus: "error" as const,
  },
};

describe("sidebar pill during sleep recovery", () => {
  it("shows blue Working while bigbud resumes a turn cut by sleep", () => {
    expect(
      resolveThreadStatusPill({
        thread: { ...erroredAfterSleepCut, recoveryStatus: "continuing" },
      }),
    ).toMatchObject({ label: "Working", pulse: true, dotClass: "bg-info-foreground" });
  });

  it("keeps the existing pills for every other recovery state", () => {
    for (const recoveryStatus of ["awaiting-user", "parked", null, undefined] as const) {
      expect(
        resolveThreadStatusPill({ thread: { ...erroredAfterSleepCut, recoveryStatus } }),
      ).toMatchObject({ label: "Failed" });
    }
  });
});
