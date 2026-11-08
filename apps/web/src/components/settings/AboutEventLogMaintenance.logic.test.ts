import type { EventLogMaintenanceProgress } from "@bigbud/contracts/server/eventLogMaintenance.ts";
import { describe, expect, it } from "vitest";

import { describeEventLogMaintenance } from "./AboutEventLogMaintenance.logic";

const progress = (
  overrides: Partial<EventLogMaintenanceProgress> = {},
): EventLogMaintenanceProgress => ({
  state: "idle",
  backlogSequences: 0,
  floorSequence: 5_000,
  floorHeldBy: "hot-window",
  retainedThroughSequence: 5_000,
  ratePerMinute: 0,
  lastBatchAt: null,
  longestBatchMs: 0,
  starved: false,
  starvedSince: null,
  lastError: null,
  lastErrorAt: null,
  backoffUntil: null,
  ...overrides,
});

describe("describeEventLogMaintenance", () => {
  it("reports an older server without maintenance as unavailable", () => {
    expect(describeEventLogMaintenance(undefined)).toMatchObject({
      tone: "muted",
      badge: null,
      details: [],
    });
  });

  it("shows backlog and rate while draining", () => {
    const summary = describeEventLogMaintenance(
      progress({ state: "draining", backlogSequences: 1_234_567, ratePerMinute: 9_000.4 }),
    );
    expect(summary.text).toBe("Cleaning old history in small batches.");
    expect(summary.tone).toBe("muted");
    expect(summary.details).toEqual(["Backlog: 1,234,567 events", "Rate: 9,000 per minute"]);
  });

  it("warns in amber when the backlog has grown for a day", () => {
    const summary = describeEventLogMaintenance(
      progress({
        state: "draining",
        starved: true,
        starvedSince: "2026-11-06T10:00:00.000Z",
        backlogSequences: 80_000,
      }),
    );
    expect(summary.tone).toBe("warning");
    expect(summary.badge).toBe("Falling behind");
    expect(summary.text).toMatch(/building up faster/);
  });

  it("shows the first line of the last error while backing off", () => {
    const summary = describeEventLogMaintenance(
      progress({
        state: "backing-off",
        lastError: "SQL error in compactVerifiedPrefix\n  at stack",
        backoffUntil: "2026-11-07T12:15:00.000Z",
      }),
    );
    expect(summary.tone).toBe("warning");
    expect(summary.details).toContain("Last error: SQL error in compactVerifiedPrefix");
  });

  it("warns in amber when one holder has pinned the floor for a day, even at backlog 0", () => {
    const summary = describeEventLogMaintenance(
      progress({
        floorHeldBy: "cleanup",
        floorPinned: true,
        floorPinnedSince: "2026-11-05T12:00:00.000Z",
      }),
    );
    expect(summary.tone).toBe("warning");
    expect(summary.badge).toBe("Cleanup blocked");
    expect(summary.text).toMatch(
      /^Old history can't be cleaned: held by an unfinished deletion cleanup since /,
    );
  });

  it("words a floor pinned by the saved checkpoint as waiting, not blocked", () => {
    const summary = describeEventLogMaintenance(
      progress({ floorHeldBy: "baseline", floorPinned: true, floorPinnedSince: null }),
    );
    expect(summary).toMatchObject({
      text: "Old history is waiting for a saved database checkpoint.",
      tone: "warning",
      badge: "Waiting for checkpoint",
    });
  });

  it("does not warn about a pinned floor while maintenance is turned off", () => {
    const summary = describeEventLogMaintenance(
      progress({ state: "disabled", floorHeldBy: "baseline", floorPinned: true }),
    );
    expect(summary).toMatchObject({ tone: "muted", badge: null });
  });

  it("stays quiet for a holder that is not yet pinned for a day", () => {
    const summary = describeEventLogMaintenance(
      progress({ floorHeldBy: "baseline", floorPinned: false, floorPinnedSince: null }),
    );
    expect(summary).toMatchObject({ text: "Up to date.", tone: "muted" });
  });
});
