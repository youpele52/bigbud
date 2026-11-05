import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { TerminalCloseInput, TerminalRestartInput, TerminalWriteInput } from "./terminal";

describe("terminal lifecycle request identity", () => {
  it("retains the no-running-process guard for identityless panes", () => {
    expect(
      Schema.decodeUnknownSync(TerminalCloseInput)({
        threadId: "thread",
        terminalId: "terminal",
        onlyIfNotRunning: true,
      }).onlyIfNotRunning,
    ).toBe(true);
  });
  it("retains optional generation fences on close and write", () => {
    expect(
      Schema.decodeUnknownSync(TerminalCloseInput)({
        threadId: "thread",
        terminalId: "terminal",
        expectedGeneration: "run-1",
      }).expectedGeneration,
    ).toBe("run-1");
    expect(
      Schema.decodeUnknownSync(TerminalWriteInput)({
        threadId: "thread",
        data: "input",
        expectedGeneration: "run-1",
      }).expectedGeneration,
    ).toBe("run-1");
  });

  it("retains restart identity while accepting legacy requests", () => {
    const parse = Schema.decodeUnknownSync(TerminalRestartInput);
    const decode = (input: Record<string, unknown>) => parse({ cols: 80, rows: 24, ...input });
    expect(decode({ threadId: "thread", cwd: "/project" }).operationId).toBeUndefined();
    expect(
      decode({
        threadId: "thread",
        cwd: "/project",
        operationId: "retry-1",
        expectedGeneration: "run-1",
      }),
    ).toMatchObject({ operationId: "retry-1", expectedGeneration: "run-1" });
  });

  it("rejects empty identities and oversized restart operation IDs", () => {
    const parse = Schema.decodeUnknownSync(TerminalRestartInput);
    const decode = (input: Record<string, unknown>) => parse({ cols: 80, rows: 24, ...input });
    for (const operationId of ["", " ", "x".repeat(129)]) {
      expect(() => decode({ threadId: "thread", cwd: "/project", operationId })).toThrow();
    }
    expect(() =>
      Schema.decodeUnknownSync(TerminalCloseInput)({
        threadId: "thread",
        expectedGeneration: " ",
      }),
    ).toThrow();
  });
});
