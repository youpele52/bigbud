/**
 * Read-only collectors behind `database-size-report.ts`. They only ever open the database
 * with SQLITE_OPEN_READONLY (the `mode=ro` equivalent) plus `query_only`, so a report can
 * run against the live packaged database without changing it.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface StorageFacts {
  readonly fileBytes: number;
  readonly walBytes: number | null;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freePages: number;
  readonly autoVacuum: "none" | "full" | "incremental";
  readonly journalMode: string;
}

export interface ObjectSize {
  readonly name: string;
  readonly type: "table" | "index" | "internal";
  readonly table: string;
  readonly bytes: number;
}

export interface TableSize {
  readonly table: string;
  readonly tableBytes: number;
  readonly indexBytes: number;
  readonly indexCount: number;
}

export interface EventsByState {
  readonly state: string;
  readonly events: number;
  readonly payloadBytes: number;
}

export interface EventLogBounds {
  readonly minSequence: number | null;
  readonly maxSequence: number | null;
  readonly oldestOccurredAt: string | null;
  readonly retainedThroughSequence: number | null;
  readonly compactThroughSequence: number | null;
}

export interface RetentionRunSummary {
  readonly createdAt: string;
  readonly trigger: string;
  readonly status: string;
  readonly selectionMode: string | null;
  readonly eligibleCount: number;
  readonly completedCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  readonly exclusionCountsJson: string | null;
}

export interface RetentionFacts {
  readonly policy: {
    readonly policy: string;
    readonly source: string;
    readonly selectionMode: string | null;
    readonly ageCriterion: string | null;
    readonly updatedAt: string;
  } | null;
  readonly runsByStatus: ReadonlyArray<{ readonly status: string; readonly runs: number }>;
  readonly recentRuns: ReadonlyArray<RetentionRunSummary>;
}

export interface AttachmentTotals {
  readonly exists: boolean;
  readonly files: number;
  readonly bytes: number;
  readonly olderFiles: number;
  readonly olderBytes: number;
}

export const LEDGER_TABLES = [
  "orchestration_command_receipts",
  "orchestration_command_receipt_claims",
  "orchestration_event_ids",
  "orchestration_event_gaps",
] as const;

type Row = Record<string, unknown>;
const num = (value: unknown): number => Number(value ?? 0);
const text = (value: unknown): string | null => (value == null ? null : String(value));

export function openReadOnlyDatabase(dbPath: string): DatabaseSync {
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA query_only = 1");
  return db;
}

const tableNames = (db: DatabaseSync): Set<string> =>
  new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String((row as Row).name)),
  );

const columnNames = (db: DatabaseSync, table: string): Set<string> =>
  new Set(
    db
      .prepare("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map((row) => String((row as Row).name)),
  );

const pragma = (db: DatabaseSync, name: string): unknown =>
  Object.values(db.prepare(`PRAGMA ${name}`).get() as Row)[0];

export function readStorage(db: DatabaseSync, dbPath: string): StorageFacts {
  const walPath = `${dbPath}-wal`;
  const autoVacuum = num(pragma(db, "auto_vacuum"));
  return {
    fileBytes: statSync(dbPath).size,
    walBytes: existsSync(walPath) ? statSync(walPath).size : null,
    pageSize: num(pragma(db, "page_size")),
    pageCount: num(pragma(db, "page_count")),
    freePages: num(pragma(db, "freelist_count")),
    autoVacuum: autoVacuum === 1 ? "full" : autoVacuum === 2 ? "incremental" : "none",
    journalMode: String(pragma(db, "journal_mode")),
  };
}

/** One row per b-tree from the aggregate `dbstat` form, so even a large file reads quickly. */
export function readObjectSizes(db: DatabaseSync): Array<ObjectSize> {
  return db
    .prepare(
      `SELECT stat.name AS name, COALESCE(master.type, 'internal') AS type,
        COALESCE(master.tbl_name, stat.name) AS tableName, stat.pgsize AS bytes
      FROM dbstat AS stat
      LEFT JOIN sqlite_master AS master ON master.name = stat.name
      WHERE stat.aggregate = TRUE
      ORDER BY stat.pgsize DESC, stat.name ASC`,
    )
    .all()
    .map((row) => {
      const value = row as Row;
      const type = String(value.type);
      return {
        name: String(value.name),
        type: type === "table" || type === "index" ? type : "internal",
        table: String(value.tableName),
        bytes: num(value.bytes),
      };
    });
}

/** Tables with their indexes folded in, largest first. */
export function summarizeTables(objects: ReadonlyArray<ObjectSize>): Array<TableSize> {
  type Entry = { table: string; tableBytes: number; indexBytes: number; indexCount: number };
  const byTable = new Map<string, Entry>();
  for (const object of objects) {
    const entry = byTable.get(object.table) ?? {
      table: object.table,
      tableBytes: 0,
      indexBytes: 0,
      indexCount: 0,
    };
    if (object.type === "index") {
      entry.indexBytes += object.bytes;
      entry.indexCount += 1;
    } else entry.tableBytes += object.bytes;
    byTable.set(object.table, entry);
  }
  return [...byTable.values()].toSorted(
    (left, right) =>
      right.tableBytes + right.indexBytes - (left.tableBytes + left.indexBytes) ||
      left.table.localeCompare(right.table),
  );
}

/** Events split by the state of their thread, as the bounded-growth plan measured them. */
export function readEventsByThreadState(db: DatabaseSync): Array<EventsByState> | null {
  const tables = tableNames(db);
  if (!tables.has("orchestration_events")) return null;
  const threads = tables.has("projection_threads");
  const archived = threads && columnNames(db, "projection_threads").has("archived_at");
  const state = threads
    ? `CASE WHEN e.aggregate_kind <> 'thread' THEN 'not a thread event'
        WHEN t.thread_id IS NULL THEN 'no projection row (thread purged)'
        WHEN t.deleted_at IS NOT NULL THEN 'soft-deleted'
        ${archived ? "WHEN t.archived_at IS NOT NULL THEN 'archived'" : ""}
        ELSE 'live' END`
    : "'unknown (no projection_threads)'";
  return db
    .prepare(
      `SELECT ${state} AS state, COUNT(*) AS events,
        COALESCE(SUM(octet_length(e.payload_json)), 0) AS payloadBytes
      FROM orchestration_events AS e
      ${threads ? "LEFT JOIN projection_threads AS t ON e.aggregate_kind = 'thread' AND t.thread_id = e.stream_id" : ""}
      GROUP BY state ORDER BY events DESC, state ASC`,
    )
    .all()
    .map((row) => {
      const value = row as Row;
      return {
        state: String(value.state),
        events: num(value.events),
        payloadBytes: num(value.payloadBytes),
      };
    });
}

export function readEventLogBounds(db: DatabaseSync): EventLogBounds | null {
  const tables = tableNames(db);
  if (!tables.has("orchestration_events")) return null;
  const bounds = db
    .prepare(
      `SELECT MIN(sequence) AS minSequence, MAX(sequence) AS maxSequence,
        (SELECT occurred_at FROM orchestration_events ORDER BY sequence ASC LIMIT 1) AS oldest
      FROM orchestration_events`,
    )
    .get() as Row;
  const retention = tables.has("orchestration_retention_state")
    ? (db
        .prepare(
          `SELECT retained_through_sequence AS retained, compact_through_sequence AS compact
          FROM orchestration_retention_state WHERE singleton_id = 1`,
        )
        .get() as Row | undefined)
    : undefined;
  return {
    minSequence: bounds.minSequence == null ? null : num(bounds.minSequence),
    maxSequence: bounds.maxSequence == null ? null : num(bounds.maxSequence),
    oldestOccurredAt: text(bounds.oldest),
    retainedThroughSequence: retention ? num(retention.retained) : null,
    compactThroughSequence: retention ? num(retention.compact) : null,
  };
}

export function readRetentionFacts(db: DatabaseSync, recentRunLimit = 5): RetentionFacts {
  const tables = tableNames(db);
  const authority = tables.has("thread_retention_policy_authority")
    ? columnNames(db, "thread_retention_policy_authority")
    : null;
  const policy = authority
    ? (db
        .prepare(
          `SELECT policy, source, updated_at AS updatedAt,
            ${authority.has("selection_mode") ? "selection_mode" : "NULL"} AS selectionMode,
            ${authority.has("age_criterion") ? "age_criterion" : "NULL"} AS ageCriterion
          FROM thread_retention_policy_authority WHERE singleton_id = 1`,
        )
        .get() as Row | undefined)
    : undefined;
  if (!tables.has("thread_retention_runs")) {
    return { policy: policy ? toPolicy(policy) : null, runsByStatus: [], recentRuns: [] };
  }
  const runColumns = columnNames(db, "thread_retention_runs");
  const optional = (column: string) => (runColumns.has(column) ? column : "NULL");
  return {
    policy: policy ? toPolicy(policy) : null,
    runsByStatus: db
      .prepare(
        "SELECT status, COUNT(*) AS runs FROM thread_retention_runs GROUP BY status ORDER BY runs DESC, status",
      )
      .all()
      .map((row) => ({ status: String((row as Row).status), runs: num((row as Row).runs) })),
    recentRuns: db
      .prepare(
        `SELECT created_at AS createdAt, trigger_kind AS trigger, status,
          ${optional("selection_mode")} AS selectionMode, eligible_count AS eligibleCount,
          completed_count AS completedCount, skipped_count AS skippedCount,
          failed_count AS failedCount, ${optional("exclusion_counts_json")} AS exclusionCountsJson
        FROM thread_retention_runs ORDER BY created_at DESC, run_id DESC LIMIT ?`,
      )
      .all(recentRunLimit)
      .map((row) => {
        const value = row as Row;
        return {
          createdAt: String(value.createdAt),
          trigger: String(value.trigger),
          status: String(value.status),
          selectionMode: text(value.selectionMode),
          eligibleCount: num(value.eligibleCount),
          completedCount: num(value.completedCount),
          skippedCount: num(value.skippedCount),
          failedCount: num(value.failedCount),
          exclusionCountsJson: text(value.exclusionCountsJson),
        };
      }),
  };
}

const toPolicy = (row: Row): NonNullable<RetentionFacts["policy"]> => ({
  policy: String(row.policy),
  source: String(row.source),
  selectionMode: text(row.selectionMode),
  ageCriterion: text(row.ageCriterion),
  updatedAt: String(row.updatedAt),
});

export function readLedgerCounts(db: DatabaseSync): Array<{ table: string; rows: number | null }> {
  const tables = tableNames(db);
  return LEDGER_TABLES.map((table) => ({
    table,
    rows: tables.has(table)
      ? num((db.prepare(`SELECT COUNT(*) AS rows FROM "${table}"`).get() as Row).rows)
      : null,
  }));
}

export function readAttachmentTotals(
  directory: string,
  nowMs: number,
  olderThanDays = 30,
): AttachmentTotals {
  const totals = {
    exists: existsSync(directory),
    files: 0,
    bytes: 0,
    olderFiles: 0,
    olderBytes: 0,
  };
  if (!totals.exists) return totals;
  const olderThanMs = nowMs - olderThanDays * 24 * 60 * 60 * 1_000;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      if (!entry.isFile()) continue;
      const stat = statSync(entryPath);
      totals.files += 1;
      totals.bytes += stat.size;
      if (stat.mtimeMs < olderThanMs) {
        totals.olderFiles += 1;
        totals.olderBytes += stat.size;
      }
    }
  }
  return totals;
}
