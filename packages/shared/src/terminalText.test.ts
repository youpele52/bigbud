import { describe, expect, it } from "vitest";
import { stripTerminalControlSequences, terminalOutputLines } from "./terminalText";

describe("stripTerminalControlSequences", () => {
  it("removes CSI, OSC, DCS and two-byte escapes but keeps text", () => {
    expect(stripTerminalControlSequences("\x1b[1;32mok\x1b[0m done")).toBe("ok done");
    expect(stripTerminalControlSequences("\x1b[?2026hframe\x1b[?2026l")).toBe("frame");
    expect(
      stripTerminalControlSequences("\x1b]0;title\x07a\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"),
    ).toBe("alink");
    expect(stripTerminalControlSequences("\x1bP1$r0m\x1b\\b\x1b(Bc\x1b=d")).toBe("bcd");
    expect(stripTerminalControlSequences("\x9b31mred\x00\x07")).toBe("red");
    expect(stripTerminalControlSequences("tail\x1b")).toBe("tail");
  });
});

describe("terminalOutputLines", () => {
  it("splits CRLF output into lines without losing content", () => {
    expect(terminalOutputLines("one\r\ntwo\r\n")).toEqual(["one", "two", ""]);
  });

  it("resolves carriage-return overwrites and backspaces the way they display", () => {
    expect(terminalOutputLines("10%\r50%\r100% done")).toEqual(["100% done"]);
    expect(terminalOutputLines("downloading 12345\rok")).toEqual(["okwnloading 12345"]);
    expect(terminalOutputLines("hellp\bo")).toEqual(["hello"]);
    expect(terminalOutputLines("\x1b[2K\r\x1b[32m✓\x1b[0m built")).toEqual(["✓ built"]);
  });
});
