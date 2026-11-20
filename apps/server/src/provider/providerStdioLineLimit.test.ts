import { describe, expect, it } from "vitest";

import { createPiStdoutReader } from "./Layers/Pi/RpcProcess.stdout.ts";
import { ProviderStdioLineTooLongError, createLineLengthGuard } from "./providerStdioLineLimit.ts";

describe("provider stdout line limit", () => {
  it("counts only the bytes since the last newline, across chunks", () => {
    const guard = createLineLengthGuard(10);
    expect(guard.observe(Buffer.from("123456"))).toBe(false);
    expect(guard.observe("7890")).toBe(false);
    expect(guard.observe(Buffer.from("1\nabc"))).toBe(false);
    expect(guard.observe("defghij")).toBe(false);
    expect(guard.observe("k")).toBe(true);
  });

  it("frames Pi records and fails once, without buffering, on an oversized record", () => {
    const lines: Array<string> = [];
    const overflows: Array<ProviderStdioLineTooLongError> = [];
    const reader = createPiStdoutReader({
      onLine: (line) => lines.push(line),
      onOverflow: (error) => overflows.push(error),
      maxLineBytes: 64,
    });

    reader.push(Buffer.from('{"a":1}\n{"b":'));
    reader.push(Buffer.from("2}\n"));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);

    // A runaway record: 10 MiB in 1 KiB chunks, no newline.
    const chunk = Buffer.alloc(1024, 0x61);
    for (let index = 0; index < 10 * 1024; index += 1) reader.push(chunk);
    reader.push(Buffer.from("\n{}\n"));
    reader.flush();

    expect(overflows).toHaveLength(1);
    expect(overflows[0]).toBeInstanceOf(ProviderStdioLineTooLongError);
    expect(overflows[0]!.message).toContain("protocol error");
    // Nothing after the overflow is delivered as a record.
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});
