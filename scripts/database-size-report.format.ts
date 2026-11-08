/**
 * Assembles and prints the database size report from the read-only collectors.
 */
import {
  openReadOnlyDatabase,
  readAttachmentTotals,
  readEventLogBounds,
  readEventsByThreadState,
  readLedgerCounts,
  readObjectSizes,
  readRetentionFacts,
  readStorage,
  summarizeTables,
  type AttachmentTotals,
  type EventLogBounds,
  type EventsByState,
  type ObjectSize,
  type RetentionFacts,
  type StorageFacts,
  type TableSize,
} from "./database-size-report.lib.ts";
import {
  readAttachmentMaintenanceFacts,
  type AttachmentMaintenanceFacts,
} from "./database-size-report.attachments.ts";
import {
  formatMaintenanceProgress,
  readMaintenanceProgress,
  type MaintenanceProgress,
} from "./database-size-report.maintenance.ts";
import { formatBytes, formatCount, formatLabeledRows, formatTable } from "./lib/report-cli.ts";

export interface DatabaseSizeReport {
  readonly dbPath: string;
  readonly attachmentsDir: string;
  readonly storage: StorageFacts;
  readonly objects: ReadonlyArray<ObjectSize>;
  readonly tables: ReadonlyArray<TableSize>;
  readonly eventsByState: ReadonlyArray<EventsByState> | null;
  readonly eventLog: EventLogBounds | null;
  readonly retention: RetentionFacts;
  readonly ledgers: ReadonlyArray<{ readonly table: string; readonly rows: number | null }>;
  readonly attachments: AttachmentTotals;
  readonly attachmentMaintenance: AttachmentMaintenanceFacts | null;
  readonly eventLogMaintenance: MaintenanceProgress | null;
  readonly elapsedMs: number;
}

export function collectDatabaseSizeReport(input: {
  readonly dbPath: string;
  readonly attachmentsDir: string;
  readonly nowMs: number;
}): DatabaseSizeReport {
  const startedAt = performance.now();
  const db = openReadOnlyDatabase(input.dbPath);
  try {
    const objects = readObjectSizes(db);
    return {
      dbPath: input.dbPath,
      attachmentsDir: input.attachmentsDir,
      storage: readStorage(db, input.dbPath),
      objects,
      tables: summarizeTables(objects),
      eventsByState: readEventsByThreadState(db),
      eventLog: readEventLogBounds(db),
      retention: readRetentionFacts(db),
      ledgers: readLedgerCounts(db),
      attachments: readAttachmentTotals(input.attachmentsDir, input.nowMs),
      attachmentMaintenance: readAttachmentMaintenanceFacts(db, input.attachmentsDir, input.nowMs),
      eventLogMaintenance: readMaintenanceProgress(db),
      elapsedMs: performance.now() - startedAt,
    };
  } finally {
    db.close();
  }
}

const orNone = (value: string | number | null | undefined) =>
  value === null || value === undefined ? "none" : String(value);

export function formatDatabaseSizeReport(report: DatabaseSizeReport, top = 20): Array<string> {
  const { storage } = report;
  const lines = [`Database: ${report.dbPath}`, ""];
  lines.push(
    ...formatLabeledRows([
      ["File size", formatBytes(storage.fileBytes), `${formatCount(storage.fileBytes)} bytes`],
      storage.walBytes === null
        ? ["WAL size", "no WAL"]
        : ["WAL size", formatBytes(storage.walBytes), `${formatCount(storage.walBytes)} bytes`],
      ["Page size", formatBytes(storage.pageSize)],
      ["Pages", formatCount(storage.pageCount)],
      [
        "Free pages",
        formatCount(storage.freePages),
        formatBytes(storage.freePages * storage.pageSize),
      ],
      ["auto_vacuum", storage.autoVacuum],
      ["journal_mode", storage.journalMode],
    ]),
  );

  lines.push("", `Largest tables, with their indexes (top ${top} of ${report.tables.length})`);
  lines.push(
    ...formatTable(
      ["table", "table", "indexes", "index size", "total"],
      report.tables
        .slice(0, top)
        .map((row) => [
          row.table,
          formatBytes(row.tableBytes),
          row.indexCount,
          formatBytes(row.indexBytes),
          formatBytes(row.tableBytes + row.indexBytes),
        ]),
    ),
  );
  const indexes = report.objects.filter((object) => object.type === "index");
  lines.push("", `Largest indexes (top ${top} of ${indexes.length})`);
  lines.push(
    ...formatTable(
      ["index", "table", "size"],
      indexes.slice(0, top).map((row) => [row.name, row.table, formatBytes(row.bytes)]),
    ),
  );

  lines.push("", "Events by thread state");
  if (report.eventsByState === null) lines.push("  no orchestration_events table");
  else
    lines.push(
      ...formatTable(
        ["state", "events", "payload"],
        report.eventsByState.map((row) => [
          row.state,
          formatCount(row.events),
          formatBytes(row.payloadBytes),
        ]),
      ),
    );
  if (report.eventLog) {
    const log = report.eventLog;
    lines.push(
      ...formatLabeledRows([
        ["Sequences", `${orNone(log.minSequence)}..${orNone(log.maxSequence)}`],
        ["Oldest event", orNone(log.oldestOccurredAt)],
        ["retained_through_sequence", orNone(log.retainedThroughSequence)],
        ["compact_through_sequence", orNone(log.compactThroughSequence)],
      ]),
    );
  }

  const { retention } = report;
  lines.push("", "Thread retention");
  lines.push(
    ...formatLabeledRows([
      ["Policy", orNone(retention.policy?.policy), retention.policy?.source],
      ["Selection mode", orNone(retention.policy?.selectionMode)],
      ["Age criterion", orNone(retention.policy?.ageCriterion)],
      ...retention.runsByStatus.map(
        (row) => [`Runs ${row.status}`, formatCount(row.runs)] as const,
      ),
    ]),
  );
  if (retention.recentRuns.length > 0) {
    lines.push(
      ...formatTable(
        ["latest runs", "trigger", "mode", "status", "eligible", "deleted", "skipped", "failed"],
        retention.recentRuns.map((run) => [
          run.createdAt,
          run.trigger,
          orNone(run.selectionMode),
          run.status,
          run.eligibleCount,
          run.completedCount,
          run.skippedCount,
          run.failedCount,
        ]),
      ),
    );
    for (const run of retention.recentRuns.filter((candidate) => candidate.exclusionCountsJson)) {
      lines.push(`  exclusions ${run.createdAt}: ${run.exclusionCountsJson}`);
    }
  }

  lines.push("", "Ledgers");
  lines.push(
    ...formatLabeledRows(
      report.ledgers.map((row) => [
        row.table,
        row.rows === null ? "missing" : formatCount(row.rows),
      ]),
    ),
  );

  const { attachments } = report;
  lines.push("", `Attachments: ${report.attachmentsDir}`);
  lines.push(
    ...(attachments.exists
      ? formatLabeledRows([
          ["Files", formatCount(attachments.files), formatBytes(attachments.bytes)],
          [
            "Older than 30 days",
            formatCount(attachments.olderFiles),
            formatBytes(attachments.olderBytes),
          ],
        ])
      : ["  directory not found"]),
  );
  lines.push(...formatAttachmentMaintenance(report.attachmentMaintenance));
  lines.push(...formatMaintenanceProgress(report.eventLogMaintenance));
  lines.push("", `Report took ${(report.elapsedMs / 1_000).toFixed(1)} s`);
  return lines;
}

const tallyRow = (label: string, tally: { files: number; bytes: number }, suffix = "") =>
  [label, formatCount(tally.files), `${formatBytes(tally.bytes)}${suffix}`] as const;

function formatAttachmentMaintenance(facts: AttachmentMaintenanceFacts | null): Array<string> {
  if (facts === null) return ["  attachment maintenance: no directory or pre-121 schema"];
  const held = Object.entries(facts.held.byReason)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");
  return formatLabeledRows([
    tallyRow("Referenced", facts.referenced),
    tallyRow("Orphans past 7-day grace", facts.orphans, "   (next sweeps trash these)"),
    tallyRow("Orphans in grace", facts.orphansInGrace),
    tallyRow("Unreferenced but held", facts.held, held ? `   (${held})` : ""),
    ["Unmanaged entries", formatCount(facts.unmanagedEntries), "(skipped by the sweep)"],
    tallyRow("Trash", facts.trash),
    tallyRow("Trash due for deletion", facts.trash.due),
    ["Trash referenced again", formatCount(facts.trash.referencedAgain), "(will be restored)"],
    tallyRow("Legacy files to backfill", facts.legacyBackfill),
    [
      "Legacy refs without a file",
      formatCount(facts.legacyBackfill.missing),
      `${formatCount(facts.legacyBackfill.ambiguous)} ambiguous`,
    ],
  ]);
}
