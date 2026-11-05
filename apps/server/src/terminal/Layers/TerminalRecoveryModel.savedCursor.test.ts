import { Terminal } from "@xterm/headless";
import { expect, it } from "vitest";
import { SerializeAddon } from "./TerminalRecoveryModel.addons.mjs";
import { serializeRecoverySavedCursor } from "./TerminalRecoveryModel.savedCursor";

const write = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));
function project(terminal: Terminal) {
  const b = terminal.buffer.active;
  return {
    type: b.type,
    x: b.cursorX,
    y: b.cursorY,
    cells: Array.from({ length: terminal.rows }, (_, y) =>
      Array.from({ length: terminal.cols }, (_, x) => {
        const c = b.getLine(b.baseY + y)!.getCell(x)!;
        return [
          c.getChars(),
          c.getFgColorMode(),
          c.getFgColor(),
          c.getBgColorMode(),
          c.getBgColor(),
          c.isBold(),
          c.isItalic(),
          c.isDim(),
          c.isUnderline(),
          c.isBlink(),
          c.isInverse(),
          c.isInvisible(),
          c.isStrikethrough(),
          c.isOverline(),
        ];
      }),
    ),
  };
}

for (const alternate of [false, true])
  for (const restore of ["\x1b8", "\x1b[u", "\x1b[?1048l"]) {
    it(`preserves saved SGR and DEC charset continuation: alternate=${alternate}, restore=${JSON.stringify(restore)}`, async () => {
      const source = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
      const target = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
      const addon = new SerializeAddon();
      source.loadAddon(addon);
      try {
        await write(
          source,
          "normal\x1b(B\x1b)B\x1b*B\x1b+B\x1b[2;3H\x1b[1;3;5;7;8;9;53;38;2;12;34;56;48;5;123m\x1b)0\x0e\x1b7\x1b[0m\x1b)B\x0f",
        );
        if (alternate)
          await write(source, "\x1b[?47hALT\x1b[4;5H\x1b[2;91;104m\x1b(0\x1b[s\x1b(B\x1b[0m");
        await write(source, "\x1b[6;7Hlive");
        const ansi = serializeRecoverySavedCursor(source, addon.serialize());
        expect(ansi).not.toBeNull();
        await write(
          target,
          ansi! + `\x1b[${source.buffer.active.cursorY + 1};${source.buffer.active.cursorX + 1}H`,
        );
        expect(project(target)).toEqual(project(source));
        for (const continuation of [restore + "lqkx", "\x1b[?1049lq", "\x1b8x", "\x0fZ"]) {
          await write(source, continuation);
          await write(target, continuation);
          expect(project(target)).toEqual(project(source));
        }
      } finally {
        source.dispose();
        target.dispose();
      }
    });
  }

it("refuses unsupported charsets, extended attributes, saved origin and offscreen nondefault registers", async () => {
  for (const sequence of [
    "\x1b(A\x1b7",
    "\x1b)0\x1b7",
    "\x1b[4m\x1b7",
    "\x1b[4:3m\x1b7",
    "\x1b[?6h\x1b7\x1b[?6l",
    "\x1b[2;3H\x1b7" + "\r\n".repeat(30),
  ]) {
    const terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
    try {
      await write(terminal, sequence);
      expect(serializeRecoverySavedCursor(terminal, "")).toBeNull();
    } finally {
      terminal.dispose();
    }
  }
});
