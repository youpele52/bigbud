/** Ordered recovery journal; not replay history and not a PTY input/response sink. */
export type TerminalRecoveryOperation =
  | { readonly type: "output"; readonly data: string }
  | { readonly type: "resize"; readonly cols: number; readonly rows: number };

export interface TerminalRecoveryCursor {
  readonly generation: string;
  /** Counts ordered model operations, including resizes; not bytes or wall-clock timestamps. */
  readonly sequence: number;
}

export type TerminalRecoveryRecord = TerminalRecoveryOperation & TerminalRecoveryCursor;
export type TerminalRecoverySuffix =
  | {
      readonly type: "suffix";
      readonly through: TerminalRecoveryCursor;
      readonly records: readonly TerminalRecoveryRecord[];
    }
  | { readonly type: "snapshot-required"; readonly through: TerminalRecoveryCursor }
  | {
      readonly type: "unavailable";
      readonly reason: "generation-mismatch" | "invalid-sequence" | "disposed";
    };

// Independently bounded records, not a change to frontend scrollback. Account UTF-16 storage
// plus per-record overhead, unlike Orca's similarly named cap measured in code units.
const RECORD_BYTES = 64;
export const TERMINAL_RECOVERY_RECORD_BYTES = 2 * 1024 * 1024;
export const TERMINAL_RECOVERY_RECORD_COUNT = 4096;

/**
 * Retains a bounded ordered suffix after operations have been applied to the live model.
 * Overflow loses only journal coverage: callers must take a NEW model snapshot, not restart
 * the process or use a truncated suffix. Manager's recovery RPC exposes independent readers.
 */
export class TerminalRecoveryRecords {
  private records: TerminalRecoveryRecord[] = [];
  private bytes = 0;
  private sequence = 0;
  private coveredAfter = 0;
  private disposed = false;

  constructor(private readonly generation: string) {
    if (generation.length === 0) throw new Error("Recovery generation must not be empty");
  }

  get cursor(): TerminalRecoveryCursor {
    return { generation: this.generation, sequence: this.sequence };
  }

  get retainedBytes(): number {
    return this.bytes;
  }

  get retainedRecords(): number {
    return this.records.length;
  }

  /** Append after model apply, or ordered forwarding after capture is permanently retired. */
  append(operation: TerminalRecoveryOperation): TerminalRecoveryCursor {
    if (this.disposed) throw new Error("Recovery journal disposed");
    if (this.sequence === Number.MAX_SAFE_INTEGER) throw new Error("Recovery sequence exhausted");
    if (
      operation.type === "resize" &&
      (!Number.isInteger(operation.cols) ||
        operation.cols < 1 ||
        operation.cols > 1000 ||
        !Number.isInteger(operation.rows) ||
        operation.rows < 1 ||
        operation.rows > 500)
    )
      throw new Error("Invalid recovery geometry");

    const bytes = RECORD_BYTES + (operation.type === "output" ? operation.data.length * 2 : 0);
    this.sequence++;
    if (
      this.bytes + bytes > TERMINAL_RECOVERY_RECORD_BYTES ||
      this.records.length >= TERMINAL_RECOVERY_RECORD_COUNT
    ) {
      this.records = [];
      this.bytes = 0;
      // The incoming operation is also covered by the next snapshot. Never retain half a read.
      this.coveredAfter = this.sequence;
      return this.cursor;
    }
    this.records.push(
      operation.type === "output"
        ? { ...this.cursor, type: "output", data: operation.data }
        : { ...this.cursor, type: "resize", cols: operation.cols, rows: operation.rows },
    );
    this.bytes += bytes;
    return this.cursor;
  }

  /** Read-only per-view catch-up: one viewer cannot drain another viewer's coverage. */
  after(cursor: TerminalRecoveryCursor): TerminalRecoverySuffix {
    if (this.disposed) return { type: "unavailable", reason: "disposed" };
    if (cursor.generation !== this.generation)
      return { type: "unavailable", reason: "generation-mismatch" };
    if (
      !Number.isSafeInteger(cursor.sequence) ||
      cursor.sequence < 0 ||
      cursor.sequence > this.sequence
    )
      return { type: "unavailable", reason: "invalid-sequence" };
    if (cursor.sequence < this.coveredAfter)
      return { type: "snapshot-required", through: this.cursor };
    const records: TerminalRecoveryRecord[] = [];
    for (const record of this.records) {
      // Readers must not obtain mutable aliases into another view's retained coverage.
      if (record.sequence > cursor.sequence) records.push({ ...record });
    }
    return {
      type: "suffix",
      through: this.cursor,
      records,
    };
  }

  /** Releases only mirror bookkeeping, never a live PTY or renderer. */
  dispose(): void {
    this.disposed = true;
    this.records = [];
    this.bytes = 0;
  }
}
