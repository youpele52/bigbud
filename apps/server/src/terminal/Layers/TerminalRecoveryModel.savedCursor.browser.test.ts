import { createRequire } from "node:module";
import { Terminal } from "@xterm/headless";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { SerializeAddon } from "./TerminalRecoveryModel.addons.mjs";
import { serializeRecoverySavedCursor } from "./TerminalRecoveryModel.savedCursor";

type BrowserTerminal = Terminal & { open(element: unknown): void };
type Realm = {
  Terminal: new (options: object) => BrowserTerminal;
  document: { createElement(tag: string): unknown };
};
const require = createRequire(import.meta.url);

it("browser continuation preserves both saved registers, SGR colors/styles and designation slots", async () => {
  const source = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
  const addon = new SerializeAddon();
  source.loadAddon(addon);
  const browser = await chromium.launch({ headless: true });
  try {
    const seed =
      "\x1b(B\x1b)0\x1b*B\x1b+Bnormal\x1b[2;3H\x1b[1;3;38;2;12;34;56;48;5;123m\x0e\x1b7\x1b[?47h\x1b[0m\x0fALT\x1b[4;5H\x1b[2;91;104m\x1b(0\x1b[s\x1b(B\x1b[0m\x1b[6;7Hlive";
    await new Promise<void>((done) => source.write(seed, done));
    const ansi = serializeRecoverySavedCursor(source, addon.serialize());
    expect(ansi).not.toBeNull();
    const page = await browser.newPage();
    await page.setContent("<!doctype html>");
    await page.addScriptTag({ path: require.resolve("@xterm/xterm") });
    const comparisons = await page.evaluate(
      async ({ seed, ansi, x, y }) => {
        const realm = globalThis as unknown as Realm;
        const live = new realm.Terminal({ cols: 40, rows: 10, allowProposedApi: true });
        const restored = new realm.Terminal({ cols: 40, rows: 10, allowProposedApi: true });
        live.open(realm.document.createElement("div"));
        restored.open(realm.document.createElement("div"));
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Runs in the browser realm, not Node.
        const write = (terminal: Terminal, data: string) =>
          new Promise<void>((done) => terminal.write(data, done));
        // Capture every cell's packed attributes, not merely visible text or cursor position.
        const project = (terminal: Terminal) => {
          const buffer = terminal.buffer.active;
          return {
            x: buffer.cursorX,
            y: buffer.cursorY,
            type: buffer.type,
            cells: Array.from({ length: live.rows }, (_, row) =>
              Array.from({ length: live.cols }, (_, col) => {
                const cell = buffer.getLine(buffer.baseY + row)!.getCell(col)!;
                return [
                  cell.getChars(),
                  (cell as unknown as { fg: number }).fg,
                  (cell as unknown as { bg: number }).bg,
                ];
              }),
            ),
          };
        };
        try {
          await write(live, seed);
          await write(restored, ansi + `\x1b[${y + 1};${x + 1}H`);
          const results = [{ live: project(live), restored: project(restored) }];
          for (const suffix of [
            "\x1b8lqkx",
            "\x1b[uq",
            "\x1b[?1048lx",
            "\x1b[?1049lq",
            "\x1b*0\x1bnq\x1b8q\x1bnq",
            "\x0fZ",
          ]) {
            await write(live, suffix);
            await write(restored, suffix);
            results.push({ live: project(live), restored: project(restored) });
          }
          return results;
        } finally {
          live.dispose();
          restored.dispose();
        }
      },
      { seed, ansi: ansi!, x: source.buffer.active.cursorX, y: source.buffer.active.cursorY },
    );
    for (const comparison of comparisons) expect(comparison.restored).toEqual(comparison.live);
  } finally {
    source.dispose();
    await browser.close();
  }
});
