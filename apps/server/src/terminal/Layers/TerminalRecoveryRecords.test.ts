import { describe, expect, it } from "vitest";
import {
  TerminalRecoveryRecords,
  TERMINAL_RECOVERY_RECORD_BYTES,
  TERMINAL_RECOVERY_RECORD_COUNT,
} from "./TerminalRecoveryRecords";

describe("ANSI recovery applied-model records", () => {
  it("orders output and resize and excludes operations already covered by the snapshot", () => {
    const journal = new TerminalRecoveryRecords("first");
    journal.append({ type: "output", data: "before" });
    const snapshotCut = journal.cursor;
    journal.append({ type: "resize", cols: 80, rows: 24 });
    journal.append({ type: "output", data: "after" });
    expect(journal.after(snapshotCut)).toEqual({
      type: "suffix",
      through: { generation: "first", sequence: 3 },
      records: [
        { generation: "first", sequence: 2, type: "resize", cols: 80, rows: 24 },
        { generation: "first", sequence: 3, type: "output", data: "after" },
      ],
    });
  });

  it("requests a fresh snapshot after byte overflow, then accepts its ordered suffix", () => {
    const journal = new TerminalRecoveryRecords("first");
    const oldCut = journal.cursor;
    journal.append({ type: "output", data: "x".repeat(TERMINAL_RECOVERY_RECORD_BYTES / 2) });
    expect(journal.retainedBytes).toBe(0);
    expect(journal.retainedRecords).toBe(0);
    expect(journal.after(oldCut).type).toBe("snapshot-required");
    const freshCut = journal.cursor; // Model snapshot must be captured at this exact applied cut.
    journal.append({ type: "output", data: "\x1b[3" });
    journal.append({ type: "output", data: "2mgreen" });
    const suffix = journal.after(freshCut);
    expect(suffix.type).toBe("suffix");
    if (suffix.type === "suffix")
      expect(suffix.records.map((record) => record.sequence)).toEqual([2, 3]);
    expect(journal.after(oldCut).type).toBe("snapshot-required");
  });

  it("bounds tiny records as well as string storage", () => {
    const journal = new TerminalRecoveryRecords("first");
    const cut = journal.cursor;
    for (let i = 0; i <= TERMINAL_RECOVERY_RECORD_COUNT; i++) {
      journal.append({ type: "resize", cols: 1000, rows: 500 });
      expect(journal.retainedRecords).toBeLessThanOrEqual(TERMINAL_RECOVERY_RECORD_COUNT);
      expect(journal.retainedBytes).toBeLessThanOrEqual(TERMINAL_RECOVERY_RECORD_BYTES);
    }
    expect(journal.after(cut).type).toBe("snapshot-required");
  });

  it("never consumes another viewer's suffix and owns its record objects", () => {
    const journal = new TerminalRecoveryRecords("first");
    const cut = journal.cursor;
    const operation = { type: "output" as const, data: "original" };
    journal.append(operation);
    operation.data = "mutated";
    const first = journal.after(cut);
    const second = journal.after(cut);
    expect(first).toEqual(second);
    if (first.type === "suffix") Object.assign(first.records[0]!, { data: "mutated again" });
    expect(journal.after(cut)).toEqual(second);
  });

  it("refuses stale generations and invalid cuts without changing coverage", () => {
    const journal = new TerminalRecoveryRecords("second");
    expect(journal.after({ generation: "first", sequence: 0 })).toEqual({
      type: "unavailable",
      reason: "generation-mismatch",
    });
    for (const sequence of [-1, 0.5, NaN, Infinity, 1])
      expect(journal.after({ generation: "second", sequence })).toEqual({
        type: "unavailable",
        reason: "invalid-sequence",
      });
    expect(journal.cursor.sequence).toBe(0);
  });

  it("does not count a rejected resize as an applied operation", () => {
    const journal = new TerminalRecoveryRecords("first");
    for (const [cols, rows] of [
      [0, 24],
      [80, 501],
      [1001, 24],
      [1.5, 24],
    ])
      expect(() => journal.append({ type: "resize", cols: cols!, rows: rows! })).toThrow(
        "geometry",
      );
    expect(journal.cursor.sequence).toBe(0);
  });

  it("releases custody on disposal and cannot resurrect an old generation", () => {
    const journal = new TerminalRecoveryRecords("first");
    journal.append({ type: "output", data: "retained" });
    const cut = journal.cursor;
    journal.dispose();
    journal.dispose();
    expect(journal.retainedBytes).toBe(0);
    expect(journal.retainedRecords).toBe(0);
    expect(journal.after(cut)).toEqual({ type: "unavailable", reason: "disposed" });
    expect(() => journal.append({ type: "output", data: "late" })).toThrow("disposed");
  });
});
