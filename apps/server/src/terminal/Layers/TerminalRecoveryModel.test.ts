import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import { createTerminalRecoveryModel, type TerminalRecoveryModel } from "./TerminalRecoveryModel";
import { RECOVERY_PENDING_BYTES } from "./TerminalRecoveryModel.budget";

const owned: TerminalRecoveryModel[] = [];
function create(cols = 80, rows = 24) {
  const model = createTerminalRecoveryModel("generation", cols, rows);
  expect(model).toBeDefined();
  owned.push(model!);
  return model!;
}
beforeEach(() => vi.stubEnv("BIGBUD_TERMINAL_RECOVERY_SHADOW", "1"));
afterEach(() => {
  for (const model of owned.splice(0)) model.dispose();
  vi.unstubAllEnvs();
});

describe("generation-owned shadow emulator", () => {
  it("parses output and resizes in one lane and captures a fixed cut", async () => {
    const model = create();
    model.write("first");
    model.resize(90, 30);
    const capture = model.capture();
    model.write("second");
    const result = await capture;
    expect(result.type).toBe("candidate");
    if (result.type !== "candidate") return;
    expect(result.frame).toMatchObject({
      generation: "generation",
      sequence: 2,
      cols: 90,
      rows: 30,
    });
    expect(result.frame.ansi).toContain("first");
    expect(result.frame.ansi).not.toContain("second");
    expect((await model.capture()).type).toBe("candidate");
  });

  it("bounds live scrollback without shrinking the renderer's configuration", async () => {
    const model = create(20, 6);
    model.write("line\r\n".repeat(1200));
    const result = await model.capture();
    expect(result.type).toBe("candidate");
    if (result.type === "candidate") expect(result.frame.scrollbackRows).toBe(1000);
  });

  it("restores a simple ANSI frame into the pinned headless peer", async () => {
    const model = create();
    model.write("\x1b[32mgreen\x1b[0m\r\nnext\x1b[?2004h");
    const result = await model.capture();
    expect(result.type).toBe("candidate");
    if (result.type !== "candidate") return;
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
      await new Promise<void>((done) => terminal.write(result.frame.ansi, done));
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("green");
      expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe("next");
      expect(terminal.modes.bracketedPasteMode).toBe(true);
    } finally {
      terminal.dispose();
    }
  });

  it("carries a partial escape separately from serialized cells", async () => {
    const model = create();
    model.write("text\x1b[3");
    const result = await model.capture();
    expect(result.type === "candidate" && result.frame.pendingEscapeTail).toBe("\x1b[3");
    model.write("2mgreen");
    const completed = await model.capture();
    expect(completed.type === "candidate" && completed.frame.pendingEscapeTail).toBe("");
  });

  it("invalidates rather than snapshotting a dropped unparsed suffix", async () => {
    const model = create();
    model.write("first");
    const pending = model.capture();
    model.write("x".repeat(RECOVERY_PENDING_BYTES));
    expect(await pending).toEqual({ type: "unavailable", reason: "unparsed-output-budget" });
    expect(await model.capture()).toEqual({
      type: "unavailable",
      reason: "unparsed-output-budget",
    });
  });

  it("releases reservations and refuses late output and captures after disposal", async () => {
    const model = create();
    model.write("pending");
    const pending = model.capture();
    model.dispose();
    model.write("late");
    model.resize(100, 30);
    expect(await pending).toEqual({ type: "unavailable", reason: "disposed" });
    for (let i = 0; i < 15; i++) create().dispose();
  });

  it("refuses oversized geometry without allocating a mirror", () => {
    expect(createTerminalRecoveryModel("generation", 1000, 500)).toBeUndefined();
  });

  it("restores mouse encoding and color overrides omitted by stock serialization", async () => {
    const model = create();
    model.write("\x1b[?1003h\x1b[?1006h\x1b]11;#123456\x1b\\colored");
    const result = await model.capture();
    expect(result.type).toBe("candidate");
    if (result.type === "candidate") {
      expect(result.frame.ansi).toContain("\x1b[?1006h");
      expect(result.frame.ansi).toContain("\x1b]11;#123456\x1b\\");
    }
    model.write("\x1b]111\x1b\\");
    const reset = await model.capture();
    expect(reset.type === "candidate" && reset.frame.ansi.includes("#123456")).toBe(false);
  });

  it("explicitly refuses live hyperlink state rather than silently losing links", async () => {
    const model = create();
    model.write("\x1b]8;id=link;https://example.invalid\x1b\\linked\x1b]8;;\x1b\\");
    expect(await model.capture()).toEqual({
      type: "unavailable",
      reason: "hyperlink-ranges-not-qualified",
    });
    expect(model.unavailableReason).toBeNull(); // Capture refusal does not kill or replace the model.
  });

  it("honors the explicit recovery opt-out", () => {
    vi.stubEnv("BIGBUD_TERMINAL_RECOVERY_SHADOW", "0");
    expect(createTerminalRecoveryModel("generation", 80, 24)).toBeUndefined();
  });

  it("does not enable unqualified recovery by default", () => {
    vi.stubEnv("BIGBUD_TERMINAL_RECOVERY_SHADOW", undefined);
    vi.stubEnv("BIGBUD_TERMINAL_RECOVERY", undefined);
    expect(createTerminalRecoveryModel("generation", 80, 24)).toBeUndefined();
  });

  it("distinguishes a split Kitty graphics query from image state", async () => {
    const model = create();
    model.write("\x1b_Gi=31,s=1,v=1,");
    expect(await model.capture()).toEqual({ type: "unavailable", reason: "image-command-pending" });
    model.write("a=q,t=d,f=24;AAAA\x1b\\text");
    model.write("\x1b]1337;Capabilities\x1b\\");
    expect((await model.capture()).type).toBe("candidate");
    model.write("\x1b_Ga=T;AAAA\x1b\\");
    expect(await model.capture()).toEqual({
      type: "unavailable",
      reason: "image-state-not-supported",
    });
  });

  it("refuses saved registers, Unicode join tails and image state instead of advertising fidelity", async () => {
    const saved = create();
    saved.write("\x1b(A\x1b[3;4H\x1b7\x1b[5;7Htext");
    expect(await saved.capture()).toEqual({
      type: "unavailable",
      reason: "saved-cursor-not-qualified",
    });
    saved.dispose();
    const unicode = create();
    unicode.write("👩\u200d");
    expect(await unicode.capture()).toEqual({
      type: "unavailable",
      reason: "unicode-continuation-not-qualified",
    });
    unicode.dispose();
    const image = create();
    image.write("\x1b_Gimage\x1b\\");
    expect(await image.capture()).toEqual({
      type: "unavailable",
      reason: "image-state-not-supported",
    });
  });
});
