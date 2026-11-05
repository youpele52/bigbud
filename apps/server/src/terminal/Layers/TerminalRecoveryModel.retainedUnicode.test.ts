import { Terminal } from "@xterm/headless";
import { expect, it } from "vitest";

interface Line {
  _combined: Record<number, string>;
}
interface Buffer {
  lines: { length: number; get(index: number): Line | undefined };
}
function retained(terminal: Terminal, buffer: "normal" | "alt"): string[] {
  const buffers = (
    terminal as unknown as { _core: { _bufferService: { buffers: Record<string, Buffer> } } }
  )._core._bufferService.buffers;
  const lines = buffers[buffer]!.lines;
  return Array.from({ length: lines.length }, (_, i) =>
    Object.values(lines.get(i)?._combined ?? {}),
  ).flat();
}
const write = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));

it("public visible cells are not a complete accounting of pinned xterm retained strings", async () => {
  const terminal = new Terminal({ cols: 10, rows: 3, allowProposedApi: true, scrollback: 20 });
  try {
    await write(terminal, "x\u0301\rY");
    expect(terminal.buffer.active.getLine(0)?.getCell(0)?.getChars()).toBe("Y");
    expect(retained(terminal, "normal")).toContain("x\u0301");
    await write(terminal, "\x1b[?1049h\x1b[2Jalt");
    expect(retained(terminal, "normal")).toContain("x\u0301");
    await write(terminal, "\x1b[?1049l\r\n" + "z\u0301\r\n".repeat(10));
    expect(terminal.buffer.normal.baseY).toBeGreaterThan(0);
    expect(retained(terminal, "normal").length).toBeGreaterThan(terminal.rows);
  } finally {
    terminal.dispose();
  }
});

it("REP expands a combined cell without additional Unicode contributions in native input", async () => {
  const terminal = new Terminal({ cols: 80, rows: 4, allowProposedApi: true });
  try {
    await write(terminal, "x\u0301\x1b[64b");
    expect(retained(terminal, "normal").filter((cell) => cell === "x\u0301")).toHaveLength(65);
  } finally {
    terminal.dispose();
  }
});
