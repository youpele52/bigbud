import { assert, describe, it } from "vitest";

import {
  type CompactionBlockerInput,
  compactionBlockers,
  DEFAULT_COMPACTION_THRESHOLDS,
  estimateCompactionDurationMs,
  expectedBytesAfterCompaction,
  isCompactionOffered,
  requiredCompactionDiskBytes,
  shouldRunIncrementalVacuum,
  toAutoVacuumMode,
} from "./DatabaseCompaction.policy.ts";

const PAGE = 4096;
const MB = 1024 * 1024;
const GB = 1024 * MB;

/** The measured copy: about 8.26 GB with about 6.6 GB of free pages. */
const realCopy = {
  pageSize: PAGE,
  pageCount: Math.round((8.26 * GB) / PAGE),
  freelistCount: Math.round((6.6 * GB) / PAGE),
  autoVacuum: "none" as const,
};

const ready = (overrides: Partial<CompactionBlockerInput> = {}): CompactionBlockerInput => ({
  stats: realCopy,
  fileBytes: realCopy.pageCount * PAGE,
  walBytes: 4 * MB,
  diskFreeBytes: 20 * GB,
  tempDisk: { sameVolume: true, freeBytes: null },
  runningTurns: 0,
  maintenance: { backlogSequences: 0, disabled: false, starved: false },
  running: false,
  ...overrides,
});

describe("database compaction policy", () => {
  it("offers compaction above 25% and 500 MB free, and not at either boundary", () => {
    assert.isTrue(isCompactionOffered(realCopy));
    const pageCount = 10_000_000;
    const stats = (freelistCount: number) => ({ ...realCopy, pageCount, freelistCount });
    // 25% exactly is not above the threshold.
    assert.isFalse(isCompactionOffered(stats(pageCount / 4)));
    assert.isTrue(isCompactionOffered(stats(pageCount / 4 + 1)));
    // 60% free but only 400 MB: too little to be worth a rebuild.
    assert.isFalse(
      isCompactionOffered({ ...realCopy, pageCount: 170_000, freelistCount: (400 * MB) / PAGE }),
    );
    assert.isFalse(
      isCompactionOffered({ ...realCopy, pageCount: 200_000, freelistCount: (500 * MB) / PAGE }),
    );
  });

  it("predicts the size after compaction from the live pages", () => {
    const expected = expectedBytesAfterCompaction(realCopy);
    assert.equal(expected, (realCopy.pageCount - realCopy.freelistCount) * PAGE);
    assert.approximately(expected / GB, 1.66, 0.01);
  });

  it("estimates a duration calibrated on the measured rebuild, growing with live content", () => {
    // Measured: a drained 8.26 GB copy with about 1 GB live rebuilt in about 7 s. The estimate
    // must not promise less, nor more than about twice that.
    const measured = estimateCompactionDurationMs(8.26 * GB, 1.0 * GB);
    assert.isAtLeast(measured, 7_000);
    assert.isAtMost(measured, 15_000);
    const real = estimateCompactionDurationMs(8.26 * GB, 1.66 * GB);
    assert.isAbove(real, measured);
    assert.isBelow(real, 60_000);
    assert.isBelow(estimateCompactionDurationMs(1.66 * GB, 1.66 * GB), real);
    assert.isBelow(estimateCompactionDurationMs(8.26 * GB, 0.5 * GB), real);
  });

  it("lists every blocker in the order the user should resolve them", () => {
    assert.deepEqual(compactionBlockers(ready()), []);
    assert.deepEqual(
      compactionBlockers(
        ready({
          running: true,
          stats: { ...realCopy, freelistCount: 0 },
          diskFreeBytes: MB,
          runningTurns: 2,
          maintenance: { backlogSequences: 500_000, disabled: false, starved: false },
        }),
      ),
      [
        "already-running",
        "below-threshold",
        "insufficient-disk",
        "running-turns",
        "maintenance-backlog",
      ],
    );
  });

  it("needs twice the live data (at least the file) plus the WAL, with 10% headroom", () => {
    const input = ready();
    const live = expectedBytesAfterCompaction(realCopy);
    // A drained file: the file size dominates twice its live data.
    const needed = Math.ceil((input.fileBytes + input.walBytes) * 1.1);
    assert.equal(requiredCompactionDiskBytes(input).database, needed);
    assert.deepEqual(compactionBlockers(ready({ diskFreeBytes: needed })), []);
    assert.deepEqual(compactionBlockers(ready({ diskFreeBytes: needed - 1 })), [
      "insufficient-disk",
    ]);
    assert.deepEqual(compactionBlockers(ready({ diskFreeBytes: null })), ["disk-unknown"]);

    // Mostly live data: the temp copy and the WAL copy each need the live size.
    const liveHeavy = { ...realCopy, freelistCount: Math.round(realCopy.pageCount * 0.3) };
    const liveHeavyLive = expectedBytesAfterCompaction(liveHeavy);
    assert.isAbove(2 * liveHeavyLive, input.fileBytes);
    assert.equal(
      requiredCompactionDiskBytes({ ...input, stats: liveHeavy }).database,
      Math.ceil((2 * liveHeavyLive + input.walBytes) * 1.1),
    );
    assert.equal(requiredCompactionDiskBytes(input).temp, Math.ceil(live * 1.1));
  });

  it("checks the temp directory's volume when it is not the database's", () => {
    const tempNeeded = requiredCompactionDiskBytes(ready()).temp;
    const withTemp = (freeBytes: number | null) =>
      compactionBlockers(ready({ tempDisk: { sameVolume: false, freeBytes } }));
    assert.deepEqual(withTemp(tempNeeded), []);
    assert.deepEqual(withTemp(tempNeeded - 1), ["insufficient-disk"]);
    assert.deepEqual(withTemp(null), ["disk-unknown"]);
    // The same volume is covered by the database check, whatever the temp reading says.
    assert.deepEqual(
      compactionBlockers(ready({ tempDisk: { sameVolume: true, freeBytes: 0 } })),
      [],
    );
  });

  it("waits only for a large, live maintenance backlog", () => {
    const limit = DEFAULT_COMPACTION_THRESHOLDS.maxMaintenanceBacklog;
    const backlog = (backlogSequences: number, extra = {}) =>
      compactionBlockers(
        ready({ maintenance: { backlogSequences, disabled: false, starved: false, ...extra } }),
      );
    assert.deepEqual(backlog(limit), []);
    assert.deepEqual(backlog(limit + 1), ["maintenance-backlog"]);
    assert.deepEqual(backlog(limit + 1, { starved: true }), []);
    assert.deepEqual(backlog(limit + 1, { disabled: true }), []);
    assert.deepEqual(compactionBlockers(ready({ maintenance: null })), []);
  });

  it("runs the steady-state incremental vacuum only in incremental mode above 10% free", () => {
    const stats = { pageSize: PAGE, pageCount: 1_000, freelistCount: 101 };
    assert.isTrue(shouldRunIncrementalVacuum({ ...stats, autoVacuum: "incremental" }));
    assert.isFalse(shouldRunIncrementalVacuum({ ...stats, autoVacuum: "none" }));
    assert.isFalse(shouldRunIncrementalVacuum({ ...stats, autoVacuum: "full" }));
    assert.isFalse(
      shouldRunIncrementalVacuum({ ...stats, freelistCount: 100, autoVacuum: "incremental" }),
    );
    assert.deepEqual([0, 1, 2, 7].map(toAutoVacuumMode), ["none", "full", "incremental", "none"]);
  });
});
