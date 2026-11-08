#!/usr/bin/env node
/**
 * Read-only size report for bigbud's local database. It opens the file with
 * SQLITE_OPEN_READONLY (the `mode=ro` equivalent) and `query_only`, so it is safe to run
 * while the app is open; it never writes, vacuums or checkpoints.
 *
 *   node scripts/database-size-report.ts [--db <state.sqlite>] [--attachments <dir>] [--top <n>]
 *
 * Defaults: `~/.bigbud/userdata/state.sqlite` and the `attachments` directory next to it.
 */
import { homedir } from "node:os";
import path from "node:path";

import {
  collectDatabaseSizeReport,
  formatDatabaseSizeReport,
} from "./database-size-report.format.ts";
import { argValue } from "./lib/report-cli.ts";

const dbPath = path.resolve(
  argValue("--db") ?? path.join(homedir(), ".bigbud", "userdata", "state.sqlite"),
);
const attachmentsDir = path.resolve(
  argValue("--attachments") ?? path.join(path.dirname(dbPath), "attachments"),
);
const top = Math.max(1, Number(argValue("--top") ?? 20) || 20);

try {
  const report = collectDatabaseSizeReport({ dbPath, attachmentsDir, nowMs: Date.now() });
  console.log(formatDatabaseSizeReport(report, top).join("\n"));
} catch (error) {
  console.error(`database-size-report: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
