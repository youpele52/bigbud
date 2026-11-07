import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAttachmentMaintenanceFacts } from "./database-size-report.attachments.ts";
import {
  formatDatabaseSizeReport,
  collectDatabaseSizeReport,
} from "./database-size-report.format.ts";
import { openReadOnlyDatabase } from "./database-size-report.lib.ts";

const DAY_MS = 24 * 60 * 60 * 1_000;
// Files are written now; the report looks at them 10 days later.
const NOW_MS = Date.now() + 10 * DAY_MS;
const id = (n: number) => `thread-1-${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
let dir: string;
let dbPath: string;
let attachmentsDir: string;

function seed() {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, deleted_at TEXT);
    CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY, attachments_json TEXT);
    CREATE TABLE projection_thread_activities (activity_id TEXT PRIMARY KEY, payload_json TEXT);
    CREATE TABLE projection_thread_attachment_refs (thread_id TEXT, attachment_id TEXT,
      source_kind TEXT, source_id TEXT, is_unresolved INTEGER);
    CREATE TABLE managed_attachment_references (source_kind TEXT, source_id TEXT,
      attachment_id TEXT, thread_id TEXT, active INTEGER);
    CREATE TABLE managed_attachment_ownership (attachment_id TEXT PRIMARY KEY,
      relative_path TEXT, lifecycle TEXT);
    CREATE TABLE direct_resource_cleanup_resources (resource_kind TEXT, relative_path TEXT,
      terminal_at TEXT);
    CREATE TABLE purge_jobs (job_id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE purge_resource_claims (job_id TEXT, resource_kind TEXT, relative_path TEXT);
    INSERT INTO projection_threads VALUES ('thread-1', NULL);
    -- Read by the attachment holds (queued prompts, pending turn starts).
    ALTER TABLE projection_threads ADD COLUMN queued_prompts_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE projection_threads ADD COLUMN pending_turn_start_json TEXT;
    INSERT INTO projection_thread_attachment_refs VALUES
      ('thread-1', '${id(2)}', 'message', 'm1', 0),
      ('thread-1', '${id(3)}', 'message', 'm1', 0),
      ('thread-1', '${id(9)}', 'message', 'm1', 0),
      ('thread-1', '', 'message', 'm2', 1);
    INSERT INTO projection_thread_messages VALUES ('m1', '[]'), ('m2', '{"broken":"${id(6)}"');
    INSERT INTO managed_attachment_ownership VALUES
      ('${id(2)}', '${id(2)}.png', 'published'), ('${id(4)}', '${id(4)}.png', 'staged');
  `);
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "bigbud-db-size-attachments-"));
  dbPath = path.join(dir, "state.sqlite");
  attachmentsDir = path.join(dir, "attachments");
  mkdirSync(path.join(attachmentsDir, ".trash"), { recursive: true });
  mkdirSync(path.join(attachmentsDir, ".submission-upload-abc"));
  seed();
  const write = (name: string, bytes: number) =>
    writeFileSync(path.join(attachmentsDir, name), Buffer.alloc(bytes));
  write(`${id(1)}.png`, 10); // orphan past grace
  write(`${id(2)}.png`, 20); // referenced, owned
  write(`${id(3)}.png`, 30); // referenced, legacy (no ownership row)
  write(`${id(4)}.png`, 40); // staged upload: held
  write(`${id(5)}.png`, 50); // orphan, modified recently
  const recent = new Date(NOW_MS - DAY_MS);
  utimesSync(path.join(attachmentsDir, `${id(5)}.png`), recent, recent);
  write(`${id(6)}.png`, 60); // named only by an unresolved reference: referenced
  write("notes.png", 70); // outside the managed layout
  write(`.trash/${NOW_MS - 8 * DAY_MS}__${id(7)}.png`, 80); // due for deletion
  write(`.trash/${NOW_MS - 8 * DAY_MS}__${id(3)}.jpg`, 90); // referenced again
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("database size report: attachment maintenance", () => {
  it("counts orphans, holds, trash and legacy backfill candidates read-only", () => {
    const before = readFileSync(dbPath);
    const db = openReadOnlyDatabase(dbPath);
    try {
      const facts = readAttachmentMaintenanceFacts(db, attachmentsDir, NOW_MS);
      expect(facts).toEqual({
        orphans: { files: 1, bytes: 10 },
        orphansInGrace: { files: 1, bytes: 50 },
        held: { files: 1, bytes: 40, byReason: { staged: 1 } },
        referenced: { files: 3, bytes: 110 },
        unmanagedEntries: 2,
        trash: { files: 2, bytes: 170, due: { files: 1, bytes: 80 }, referencedAgain: 1 },
        legacyBackfill: { files: 1, bytes: 30, missing: 1, ambiguous: 0 },
      });
    } finally {
      db.close();
    }
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  it("prints the section in the full report", () => {
    const report = collectDatabaseSizeReport({ dbPath, attachmentsDir, nowMs: NOW_MS });
    const text = formatDatabaseSizeReport(report).join("\n");
    for (const phrase of ["Orphans past 7-day grace", "Trash due for deletion", "Legacy files"]) {
      expect(text).toContain(phrase);
    }
  });
});
