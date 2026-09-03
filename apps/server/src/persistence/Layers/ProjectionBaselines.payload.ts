import {
  PROJECTION_BASELINE_TABLES,
  PROJECTION_BASELINE_THREAD_OWNED_TABLES,
} from "../ProjectionBaselineSchema.ts";

export type BaselinePayload = {
  readonly tables: Record<string, ReadonlyArray<Record<string, unknown>>>;
};

export interface BaselineSanitization {
  readonly table: (typeof PROJECTION_BASELINE_THREAD_OWNED_TABLES)[number];
  readonly removedCount: number;
}

export function parseBaselinePayload(payloadJson: string): BaselinePayload {
  const value: unknown = JSON.parse(payloadJson);
  if (typeof value !== "object" || value === null || !("tables" in value)) {
    throw new Error("baseline payload has no tables object");
  }
  const tables = (value as { tables?: unknown }).tables;
  if (typeof tables !== "object" || tables === null) {
    throw new Error("baseline payload tables are invalid");
  }
  for (const table of PROJECTION_BASELINE_TABLES) {
    if (!Array.isArray((tables as Record<string, unknown>)[table])) {
      throw new Error(`baseline payload is missing ${table}`);
    }
  }
  return value as BaselinePayload;
}

export function sanitizeLegacyThreadOwnedRows(payload: BaselinePayload): {
  readonly payload: BaselinePayload;
  readonly sanitization: ReadonlyArray<BaselineSanitization>;
} {
  const threadRows = payload.tables.projection_threads!;
  const restoredThreadIds = new Set<string>();
  for (const row of threadRows) {
    if (typeof row.thread_id !== "string") {
      throw new Error("baseline projection_threads row has an invalid thread_id");
    }
    restoredThreadIds.add(row.thread_id);
  }

  const tables = { ...payload.tables };
  const sanitization: BaselineSanitization[] = [];
  for (const table of PROJECTION_BASELINE_THREAD_OWNED_TABLES) {
    const rows = payload.tables[table]!;
    const retained = rows.filter((row) => {
      if (typeof row.thread_id !== "string") {
        throw new Error(`baseline ${table} row has an invalid thread_id`);
      }
      return restoredThreadIds.has(row.thread_id);
    });
    const removedCount = rows.length - retained.length;
    if (removedCount > 0) sanitization.push({ table, removedCount });
    tables[table] = retained;
  }
  return { payload: { tables }, sanitization };
}
