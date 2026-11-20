import { describe, expect, it } from "vitest";
import { createTerminalSubmitDetector } from "./terminalSubmitDetector.ts";

describe("createTerminalSubmitDetector", () => {
  it("counts Enter (CR) and LF as a submitted line", () => {
    expect(createTerminalSubmitDetector()("npm test\r")).toBe(true);
    expect(createTerminalSubmitDetector()("\n")).toBe(true);
  });

  it("ignores typing without Enter, focus reports and arrow keys", () => {
    const submitted = createTerminalSubmitDetector();
    expect(submitted("npm tes")).toBe(false);
    expect(submitted("\u001b[I\u001b[O")).toBe(false);
    expect(submitted("\u001b[A")).toBe(false);
  });

  it("never counts newlines inside a bracketed paste, even across writes", () => {
    const submitted = createTerminalSubmitDetector();
    expect(submitted("\u001b[200~line one\nline two\r")).toBe(false);
    expect(submitted("still pasting\n")).toBe(false);
    expect(submitted("end\u001b[201~")).toBe(false);
    expect(submitted("\r")).toBe(true);
  });

  it("completes a paste marker split between writes", () => {
    const submitted = createTerminalSubmitDetector();
    expect(submitted("\u001b[20")).toBe(false);
    expect(submitted("0~pasted\n")).toBe(false);
    expect(submitted("\u001b[201~\r")).toBe(true);
  });

  it("treats Alt+Enter as a newline and kitty Enter as a submission", () => {
    expect(createTerminalSubmitDetector()("\u001b\r")).toBe(false);
    expect(createTerminalSubmitDetector()("\u001b[13u")).toBe(true);
    expect(createTerminalSubmitDetector()("\u001b[13;1u")).toBe(true);
    expect(createTerminalSubmitDetector()("\u001b[13;2u")).toBe(false);
    expect(createTerminalSubmitDetector()("\u001b[200~\u001b[13u\u001b[201~")).toBe(false);
  });
});
