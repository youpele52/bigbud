import type { ServerThreadRetentionRun } from "@bigbud/contracts/server/threadRetention";
import { afterEach, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ add: vi.fn(() => "toast-id"), update: vi.fn() }));
vi.mock("../ui/toast", () => ({ toastManager: toast }));

import {
  formatRetentionResourceOutcomes,
  publishReconnectToast,
  publishRunToast,
  retentionToast,
} from "./ThreadRetentionSettingsSection.progress";

const run: ServerThreadRetentionRun = {
  runId: "heartbeat-run",
  trigger: "manual",
  policy: "7-days",
  selectionMode: "per-thread",
  ageCriterion: "created",
  cutoffAt: "2026-09-16T00:00:00.000Z",
  status: "selecting",
  eligibleCount: 3,
  selectedCount: 3,
  requestedCount: 1,
  completedCount: 1,
  skippedCount: 0,
  failedCount: 0,
  removableResourceCount: 2,
  completedResourceCount: 1,
  retainedResourceCount: 0,
  blockedResourceCount: 0,
  canonicalPendingCount: 1,
  createdAt: "2026-09-23T00:00:00.000Z",
  updatedAt: "2026-09-23T00:01:00.000Z",
  completedAt: null,
  deferredReason: null,
  errorMessage: null,
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("reports each retained or blocked resource category in one line", () => {
  const classified = {
    ...run,
    status: "completed_with_failures" as const,
    retainedResourceCount: 3,
    retainedSharedResourceCount: 1,
    retainedExternalResourceCount: 1,
    unverifiedResourceCount: 1,
    blockedResourceCount: 2,
    pendingResourceCount: 1,
  };
  expect(formatRetentionResourceOutcomes(classified)).toBe(
    "1 shared, 1 external, 1 unverified, 2 blocked, 1 pending",
  );
  expect(retentionToast(classified)).toEqual({
    type: "warning",
    title: "Cleanup: 1/3 deleted · 1 shared, 1 external, 1 unverified, 2 blocked, 1 pending.",
    timeout: 8_000,
  });
});

it("refreshes one unchanged run toast every five minutes and recovers immediately", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-23T00:00:00.000Z"));
  publishRunToast(run);
  expect(toast.add).toHaveBeenCalledTimes(1);
  publishRunToast(run);
  expect(toast.update).not.toHaveBeenCalled();
  vi.advanceTimersByTime(5 * 60_000);
  publishRunToast(run);
  expect(toast.update).toHaveBeenCalledTimes(1);
  publishReconnectToast(run.runId);
  expect(toast.add).toHaveBeenLastCalledWith(
    expect.objectContaining({
      id: "toast-id",
      type: "loading",
      title: "Cleanup: reconnecting for progress…",
    }),
  );
  publishRunToast(run);
  expect(toast.update).toHaveBeenLastCalledWith(
    "toast-id",
    expect.objectContaining({
      type: "loading",
      title: "Cleanup: 1/3 deleted · 0 outcomes, 0 resources pending.",
    }),
  );
  publishRunToast({ ...run, status: "completed", completedCount: 3 });
  expect(toast.update).toHaveBeenLastCalledWith(
    "toast-id",
    expect.objectContaining({
      type: "success",
      title: "Cleanup finished: 3 threads deleted.",
    }),
  );
  expect(toast.add).toHaveBeenCalledTimes(2);
});
