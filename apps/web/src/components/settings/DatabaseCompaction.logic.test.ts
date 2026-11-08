import type {
  DatabaseCompactionPreview,
  DatabaseCompactionRun,
} from "@bigbud/contracts/server/databaseCompaction.ts";
import { describe, expect, it } from "vitest";

import {
  compactionRunKey,
  describeCompactionRow,
  formatCompactionDuration,
  formatDatabaseBytes,
  getCompactionConfirmState,
  getCompactionLoaderMessage,
  getCompactionPreviewItems,
  getCompactionRunToast,
} from "./DatabaseCompaction.logic";

const MB = 1024 * 1024;
const GB = 1024 * MB;

const offeredPreview: DatabaseCompactionPreview = {
  generatedAt: "2026-11-07T10:00:00.000Z",
  fileBytes: Math.round(8.26 * GB),
  walBytes: 4 * MB,
  pageSize: 4096,
  pageCount: Math.round((8.26 * GB) / 4096),
  freelistCount: Math.round((6.6 * GB) / 4096),
  freeBytes: Math.round(6.6 * GB),
  freeFraction: 0.8,
  expectedBytes: Math.round(1.66 * GB),
  autoVacuum: "none",
  diskFreeBytes: 40 * GB,
  requiredDiskBytes: Math.round(8.26 * GB) + 4 * MB,
  runningTurns: 0,
  maintenanceBacklog: 0,
  estimatedDurationMs: 65_000,
  offered: true,
  blockers: [],
};

const run = (overrides: Partial<DatabaseCompactionRun> = {}): DatabaseCompactionRun => ({
  outcome: "completed",
  startedAt: "2026-11-07T10:00:00.000Z",
  finishedAt: "2026-11-07T10:01:05.000Z",
  bytesBefore: Math.round(8.26 * GB),
  bytesAfter: Math.round(1.2 * GB),
  checkpointComplete: true,
  error: null,
  ...overrides,
});

describe("database compaction formatting", () => {
  it("formats sizes and rough durations", () => {
    expect(formatDatabaseBytes(Math.round(8.26 * GB))).toBe("8.3 GB");
    expect(formatDatabaseBytes(12 * GB)).toBe("12 GB");
    expect(formatDatabaseBytes(640 * MB)).toBe("640 MB");
    expect(formatDatabaseBytes(2048)).toBe("2 KB");
    expect(formatDatabaseBytes(12)).toBe("12 B");
    expect(formatCompactionDuration(400)).toBe("about 1 second");
    expect(formatCompactionDuration(45_000)).toBe("about 45 seconds");
    expect(formatCompactionDuration(65_000)).toBe("about 1 minute");
    expect(formatCompactionDuration(5 * 60_000)).toBe("about 5 minutes");
  });
});

describe("database compaction row", () => {
  it("offers the action with the expected saving when free space is large", () => {
    expect(describeCompactionRow({ preview: offeredPreview, error: null, running: false })).toEqual(
      {
        summary: "8.3 GB · 6.6 GB free (80%) · about 1.7 GB after compaction",
        actionEnabled: true,
      },
    );
  });

  it("shows the current size and stays disabled below the threshold", () => {
    const state = describeCompactionRow({
      preview: {
        ...offeredPreview,
        fileBytes: 1.2 * GB,
        freeBytes: 40 * MB,
        freeFraction: 0.03,
        offered: false,
        blockers: ["below-threshold"],
      },
      error: null,
      running: false,
    });
    expect(state.actionEnabled).toBe(false);
    expect(state.summary).toBe("1.2 GB · 40 MB free (3%). Nothing worth compacting right now.");
  });

  it("is disabled while loading, failing or running", () => {
    expect(describeCompactionRow({ preview: null, error: null, running: false })).toEqual({
      summary: "Checking database size…",
      actionEnabled: false,
    });
    expect(
      describeCompactionRow({ preview: null, error: "socket", running: false }).actionEnabled,
    ).toBe(false);
    expect(describeCompactionRow({ preview: offeredPreview, error: null, running: true })).toEqual({
      summary: "Compacting the database…",
      actionEnabled: false,
    });
  });
});

describe("database compaction preview and confirmation", () => {
  it("lists size, free pages, expected size, free disk and duration", () => {
    expect(getCompactionPreviewItems(offeredPreview)).toEqual([
      { label: "Current size", value: "8.3 GB" },
      { label: "Free pages", value: "6.6 GB (80%)" },
      { label: "Expected size after", value: "1.7 GB" },
      { label: "Free disk space", value: "40 GB (needs 8.3 GB)" },
      { label: "Estimated duration", value: "about 1 minute" },
    ]);
    expect(getCompactionPreviewItems({ ...offeredPreview, diskFreeBytes: null })[3]?.value).toBe(
      "Unknown",
    );
  });

  it("confirms only with a fresh preview and no blockers", () => {
    expect(
      getCompactionConfirmState({ preview: offeredPreview, previewBusy: false, actionBusy: false }),
    ).toEqual({ canConfirm: true, blockers: [] });
    expect(
      getCompactionConfirmState({ preview: null, previewBusy: false, actionBusy: false })
        .canConfirm,
    ).toBe(false);
    expect(
      getCompactionConfirmState({ preview: offeredPreview, previewBusy: true, actionBusy: false })
        .canConfirm,
    ).toBe(false);
    expect(
      getCompactionConfirmState({ preview: offeredPreview, previewBusy: false, actionBusy: true })
        .canConfirm,
    ).toBe(false);
    const blocked = getCompactionConfirmState({
      preview: { ...offeredPreview, blockers: ["insufficient-disk", "running-turns"] },
      previewBusy: false,
      actionBusy: false,
    });
    expect(blocked.canConfirm).toBe(false);
    expect(blocked.blockers).toEqual([
      "Not enough free disk space: compaction needs at least the database size.",
      "A turn is running. Wait for it to finish before compacting.",
    ]);
  });
});

describe("database compaction outcomes", () => {
  it("uses green for done, amber for partial or interrupted and red for failures", () => {
    expect(getCompactionRunToast(run())).toEqual({
      type: "success",
      title: "Database compacted",
      description: "8.3 GB → 1.2 GB",
    });
    expect(getCompactionRunToast(run({ checkpointComplete: false })).type).toBe("warning");
    expect(getCompactionRunToast(run({ outcome: "interrupted", bytesAfter: null }))).toMatchObject({
      type: "warning",
      title: "Database compaction was interrupted",
    });
    expect(
      getCompactionRunToast(
        run({ outcome: "failed", bytesAfter: null, error: "database is locked" }),
      ),
    ).toEqual({
      type: "error",
      title: "Database compaction failed",
      description: "database is locked The database was not changed.",
    });
    expect(compactionRunKey(run())).toBe("2026-11-07T10:00:00.000Z:completed");
  });

  it("passes on what the server knows about an interrupted or untidy run, in amber", () => {
    const unknown =
      "The backend stopped during compaction, and bigbud cannot tell whether the rebuild finished.";
    const interrupted = getCompactionRunToast(
      run({ outcome: "interrupted", bytesAfter: null, error: unknown }),
    );
    expect(interrupted.type).toBe("warning");
    expect(interrupted.description).toContain(unknown);
    expect(interrupted.description).not.toContain("left as it was");
    expect(
      getCompactionRunToast(run({ error: "Could not remove the marker: EACCES." })),
    ).toMatchObject({ type: "warning", title: "Database compacted" });
  });

  it("explains why an in-process backend cannot compact", () => {
    const state = getCompactionConfirmState({
      preview: { ...offeredPreview, blockers: ["in-process-sqlite"] },
      previewBusy: false,
      actionBusy: false,
    });
    expect(state.canConfirm).toBe(false);
    expect(state.blockers[0]).toContain("main thread");
  });

  it("explains the loader by phase, with the estimate, and while reconnecting", () => {
    const status = {
      state: "running" as const,
      phase: "vacuuming" as const,
      startedAt: "2026-11-07T10:00:00.000Z",
      estimatedDurationMs: 65_000,
      lastRun: null,
    };
    expect(getCompactionLoaderMessage(status, false)).toEqual({
      title: "Compacting the database",
      detail:
        "Rebuilding the database without its free space. It takes about 1 minute. bigbud is paused until it finishes, and your threads are safe.",
    });
    expect(
      getCompactionLoaderMessage({ ...status, phase: "checkpointing" }, false).detail,
    ).toContain("Writing the compacted file to disk.");
    expect(getCompactionLoaderMessage(status, true).detail).toContain(
      "Waiting for the backend to answer.",
    );
  });
});
