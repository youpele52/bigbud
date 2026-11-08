import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectDatabaseSizeReport,
  formatDatabaseSizeReport,
} from "./database-size-report.format.ts";
import { openReadOnlyDatabase } from "./database-size-report.lib.ts";

const NOW_MS = Date.parse("2026-11-06T12:00:00.000Z");
const ROOT = path.resolve(import.meta.dirname, "..");
let dir: string;
let dbPath: string;
let attachmentsDir: string;

function seedDatabase(file: string) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      aggregate_kind TEXT NOT NULL, stream_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
      correlation_id TEXT, payload_json TEXT NOT NULL);
    CREATE INDEX idx_orch_events_correlation_id ON orchestration_events(correlation_id);
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, deleted_at TEXT, archived_at TEXT);
    CREATE TABLE orchestration_retention_state (singleton_id INTEGER PRIMARY KEY,
      retained_through_sequence INTEGER NOT NULL, compact_through_sequence INTEGER NOT NULL,
      updated_at TEXT NOT NULL);
    CREATE TABLE thread_retention_policy_authority (singleton_id INTEGER PRIMARY KEY,
      policy TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL,
      selection_mode TEXT, age_criterion TEXT);
    CREATE TABLE thread_retention_runs (run_id TEXT PRIMARY KEY, trigger_kind TEXT, status TEXT,
      selection_mode TEXT, eligible_count INTEGER, completed_count INTEGER, skipped_count INTEGER,
      failed_count INTEGER, exclusion_counts_json TEXT, created_at TEXT);
    CREATE TABLE orchestration_command_receipts (command_id TEXT PRIMARY KEY);
    CREATE TABLE orchestration_event_ids (event_id TEXT PRIMARY KEY, sequence INTEGER);
    INSERT INTO projection_threads VALUES ('live', NULL, NULL), ('gone', '2026-10-01', NULL),
      ('shelved', NULL, '2026-10-01');
    INSERT INTO orchestration_retention_state VALUES (1, 2, 5, '2026-11-01');
    INSERT INTO thread_retention_policy_authority
      VALUES (1, '3-days', 'explicit', '2026-11-01', 'legacy-subtree', 'last-conversation-activity');
    INSERT INTO thread_retention_runs VALUES
      ('r1', 'scheduled', 'completed', 'legacy-subtree', 0, 0, 0, 0,
        '{"olderThanCutoffCount":2,"exclusionCounts":[{"reason":"running","count":2}]}',
        '2026-11-05T00:00:00.000Z'),
      ('r2', 'scheduled', 'cancelled', 'legacy-subtree', 0, 0, 0, 0, NULL,
        '2026-11-04T00:00:00.000Z');
    INSERT INTO orchestration_command_receipts VALUES ('c1'), ('c2'), ('c3');
    INSERT INTO orchestration_event_ids VALUES ('e1', 1);
  `);
  const insert = db.prepare(
    "INSERT INTO orchestration_events (aggregate_kind, stream_id, occurred_at, payload_json) VALUES (?, ?, ?, ?)",
  );
  const events = [
    ["thread", "purged", "2026-04-24T00:00:00.000Z", "x".repeat(100)],
    ["thread", "purged", "2026-04-25T00:00:00.000Z", "x".repeat(100)],
    ["thread", "gone", "2026-05-01T00:00:00.000Z", "y".repeat(10)],
    ["thread", "live", "2026-11-01T00:00:00.000Z", "z".repeat(10)],
    ["thread", "shelved", "2026-11-01T00:00:00.000Z", "é"],
    ["project", "live", "2026-11-01T00:00:00.000Z", "{}"],
  ] as const;
  for (const event of events) insert.run(...event);
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bigbud-db-size-report-"));
  dbPath = path.join(dir, "state.sqlite");
  attachmentsDir = path.join(dir, "attachments");
  seedDatabase(dbPath);
  mkdirSync(path.join(attachmentsDir, "nested"), { recursive: true });
  writeFileSync(path.join(attachmentsDir, "new.png"), Buffer.alloc(300));
  const old = path.join(attachmentsDir, "nested", "old.png");
  writeFileSync(old, Buffer.alloc(200));
  const fortyDaysAgo = new Date(NOW_MS - 40 * 24 * 60 * 60 * 1_000);
  utimesSync(old, fortyDaysAgo, fortyDaysAgo);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("database size report", () => {
  it("reports sizes, events by thread state, retention, ledgers and attachments", () => {
    const report = collectDatabaseSizeReport({ dbPath, attachmentsDir, nowMs: NOW_MS });

    expect(report.storage).toMatchObject({
      pageSize: 4096,
      autoVacuum: "none",
      journalMode: "wal",
    });
    expect(report.storage.walBytes).not.toBeNull();
    expect(report.objects.map((object) => object.name)).toContain("idx_orch_events_correlation_id");
    const events = report.tables.find((table) => table.table === "orchestration_events");
    expect(events).toMatchObject({ indexCount: 1 });
    expect(events!.tableBytes).toBeGreaterThan(0);

    expect(report.eventsByState).toEqual([
      { state: "no projection row (thread purged)", events: 2, payloadBytes: 200 },
      { state: "archived", events: 1, payloadBytes: 2 },
      { state: "live", events: 1, payloadBytes: 10 },
      { state: "not a thread event", events: 1, payloadBytes: 2 },
      { state: "soft-deleted", events: 1, payloadBytes: 10 },
    ]);
    expect(report.eventLog).toEqual({
      minSequence: 1,
      maxSequence: 6,
      oldestOccurredAt: "2026-04-24T00:00:00.000Z",
      retainedThroughSequence: 2,
      compactThroughSequence: 5,
    });
    expect(report.retention.policy).toMatchObject({
      policy: "3-days",
      selectionMode: "legacy-subtree",
    });
    expect(report.retention.runsByStatus).toHaveLength(2);
    expect(report.retention.recentRuns[0]?.exclusionCountsJson).toContain('"running"');
    expect(report.ledgers).toEqual([
      { table: "orchestration_command_receipts", rows: 3 },
      { table: "orchestration_command_receipt_claims", rows: null },
      { table: "orchestration_event_ids", rows: 1 },
      { table: "orchestration_event_gaps", rows: null },
    ]);
    expect(report.attachments).toEqual({
      exists: true,
      files: 2,
      bytes: 500,
      olderFiles: 1,
      olderBytes: 200,
    });

    const text = formatDatabaseSizeReport(report).join("\n");
    for (const phrase of [
      "Free pages",
      "auto_vacuum",
      "Largest indexes",
      "no projection row (thread purged)",
      "compact_through_sequence",
      "exclusions 2026-11-05T00:00:00.000Z",
      "orchestration_command_receipt_claims",
      "Older than 30 days",
    ]) {
      expect(text).toContain(phrase);
    }
  });

  it("never writes to the database it reports on", () => {
    const before = readFileSync(dbPath);
    collectDatabaseSizeReport({ dbPath, attachmentsDir, nowMs: NOW_MS });
    expect(readFileSync(dbPath).equals(before)).toBe(true);

    const db = openReadOnlyDatabase(dbPath);
    try {
      expect(() => db.exec("CREATE TABLE written (id INTEGER)")).toThrow();
    } finally {
      db.close();
    }
    expect(() => openReadOnlyDatabase(path.join(dir, "missing.sqlite"))).toThrow(/no database/);
  });

  it("runs under plain node with --db", () => {
    const result = spawnSync(
      "node",
      ["scripts/database-size-report.ts", "--db", dbPath, "--top", "3"],
      { cwd: ROOT, encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Database: ${dbPath}`);
    expect(result.stdout).toContain("Largest tables, with their indexes (top 3 of");
    expect(result.stdout).toContain(`Attachments: ${attachmentsDir}`);
  });
});
