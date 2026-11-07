import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openReadOnlyDatabase } from "./database-size-report.lib.ts";
import {
  formatMaintenanceProgress,
  readMaintenanceProgress,
} from "./database-size-report.maintenance.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bigbud-size-maintenance-"));
  dbPath = path.join(dir, "state.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const read = () => {
  const db = openReadOnlyDatabase(dbPath);
  try {
    return readMaintenanceProgress(db);
  } finally {
    db.close();
  }
};

describe("event-log maintenance in the size report", () => {
  it("says so when the database has no maintenance state yet", () => {
    new DatabaseSync(dbPath).close();
    expect(read()).toBeNull();
    expect(formatMaintenanceProgress(null).join("\n")).toContain("not yet run");
  });

  it("prints backlog, rate and the starved warning from the state row", () => {
    const db = new DatabaseSync(dbPath);
    // Mirrors migration 156.
    db.exec(`
      CREATE TABLE event_log_maintenance_state (
        singleton_id INTEGER PRIMARY KEY, floor_sequence INTEGER, floor_held_by TEXT,
        backlog_sequences INTEGER, backlog_low_water INTEGER, backlog_low_water_at TEXT,
        starved INTEGER, starved_since TEXT, last_batch_at TEXT, longest_batch_ms REAL,
        rate_per_minute REAL, events_deleted INTEGER, gaps_deleted INTEGER,
        receipts_deleted INTEGER, claims_deleted INTEGER, event_ids_deleted INTEGER,
        receipts_through_sequence INTEGER, last_error TEXT, last_error_at TEXT,
        backoff_until TEXT, updated_at TEXT
      );
      INSERT INTO event_log_maintenance_state VALUES (1, 5200000, 'hot-window', 80000, 1000,
        '2026-11-05T00:00:00.000Z', 1, '2026-11-06T00:00:00.000Z', '2026-11-07T00:00:00.000Z',
        31.5, 1200, 4000000, 1100000, 3900000, 1500000, 4100000, 5100000, NULL, NULL, NULL,
        '2026-11-07T00:00:00.000Z');
    `);
    db.close();

    const progress = read();
    expect(progress).toMatchObject({
      floorHeldBy: "hot-window",
      backlogSequences: 80_000,
      starved: true,
      eventsDeleted: 4_000_000,
    });
    const text = formatMaintenanceProgress(progress).join("\n");
    expect(text).toContain("WARNING: the compaction backlog has grown for 24 hours");
    expect(text).toContain("80,000");
    expect(text).toContain("held by hot-window");
  });
});
