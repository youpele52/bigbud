import { readArray, readObject } from "./codexAppServerManager.protocol.ts";

export interface CodexReadLimits {
  readonly pages: number;
  readonly records: number;
  readonly bytes: number;
  readonly timeoutMs: number;
}

export const CODEX_READ_LIMITS: CodexReadLimits = {
  pages: 1000,
  records: 100_000,
  bytes: 64 * 1024 * 1024,
  timeoutMs: 60_000,
};

/** One aggregate budget is shared by nested turn/item pages, not reset per RPC. */
export class CodexReadBudget {
  private pages = 0;
  private records = 0;
  private bytes = 0;
  private readonly deadline: number;
  constructor(private readonly limits: CodexReadLimits = CODEX_READ_LIMITS) {
    this.deadline = Date.now() + limits.timeoutMs;
  }
  remainingMs(): number {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) throw new Error("Codex read exceeded its total deadline.");
    return remaining;
  }
  consume(value: unknown, records: number): void {
    this.remainingMs();
    this.pages += 1;
    this.records += records;
    this.bytes += Buffer.byteLength(JSON.stringify(value));
    if (
      this.pages > this.limits.pages ||
      this.records > this.limits.records ||
      this.bytes > this.limits.bytes
    ) {
      throw new Error("Codex read exceeded its bounded history/catalog budget.");
    }
  }
  addRecords(records: number): void {
    this.records += records;
    if (this.records > this.limits.records)
      throw new Error("Codex read exceeded its record budget.");
  }
}

/** Validates a complete page and rejects repeated or non-progressing cursors. */
export function readCodexPage(
  value: unknown,
  cursors: Set<string>,
  budget: CodexReadBudget,
  allowLegacyMissingCursor = false,
): { data: unknown[]; nextCursor: string | null } {
  const record = readObject(value);
  const data = readArray(record, "data");
  const cursor = record?.nextCursor;
  if (
    !data ||
    (cursor !== null &&
      !(allowLegacyMissingCursor && cursor === undefined) &&
      (typeof cursor !== "string" || cursor.length === 0))
  ) {
    throw new Error("Codex returned a malformed pagination page.");
  }
  budget.consume(value, data.length);
  if (typeof cursor === "string") {
    if (cursors.has(cursor) || data.length === 0)
      throw new Error("Codex pagination made no progress.");
    cursors.add(cursor);
  }
  return { data, nextCursor: typeof cursor === "string" ? cursor : null };
}
