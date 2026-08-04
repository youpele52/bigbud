import { describe, expect, it } from "vitest";

import {
  getRetentionPollIntervalMs,
  shouldReplaceRetentionRun,
} from "./ThreadRetentionSettingsSection.logic";

const RUN = {
  runId: "run-1",
  trigger: "manual",
  policy: "7-days",
  cutoffAt: "2026-07-28T00:00:00.000Z",
  status: "queued",
  eligibleCount: 2,
  selectedCount: 0,
  requestedCount: 0,
  completedCount: 0,
  skippedCount: 0,
  failedCount: 0,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
  completedAt: null,
  deferredReason: null,
  errorMessage: null,
} as const;

describe("ThreadRetentionSettingsSection logic", () => {
  it("polls active and deferred runs but stops at every terminal state", () => {
    expect(getRetentionPollIntervalMs(RUN)).toBe(2_000);
    expect(getRetentionPollIntervalMs({ ...RUN, status: "deferred" })).toBe(5_000);

    for (const status of ["completed", "completed_with_failures", "failed", "cancelled"] as const) {
      expect(getRetentionPollIntervalMs({ ...RUN, status })).toBeNull();
    }
  });

  it("rejects stale refreshes for the current run and accepts a newer run", () => {
    const current = { ...RUN, updatedAt: "2026-08-04T00:00:02.000Z" };
    expect(
      shouldReplaceRetentionRun(current, { ...RUN, updatedAt: "2026-08-04T00:00:01.000Z" }),
    ).toBe(false);
    expect(
      shouldReplaceRetentionRun(current, {
        ...RUN,
        runId: "run-2",
        updatedAt: "2026-08-04T00:00:01.000Z",
      }),
    ).toBe(true);
  });
});
