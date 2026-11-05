import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { captureProductionState, parserProfile } from "./checkpoint.production.state.mjs";
import {
  estimateProductionCapture,
  PRODUCTION_CHECKPOINT_BUDGET,
} from "./checkpoint.production.budget.mjs";
import { activateTerminalUnicodeProvider } from "../../apps/web/src/components/terminal/terminalUnicodeProvider.ts";

// Keep the resource counter raw: Bun/platform units need not match Node's documented KiB.
const usage = () => ({
  ...process.memoryUsage(),
  maxRSSRuntimeRaw: process.resourceUsage().maxRSS,
});
function digest(terminal) {
  const hash = createHash("sha256");
  for (const buffer of [terminal._core.buffers.normal, terminal._core.buffers.alt])
    for (let i = 0; i < buffer.lines.length; i++) {
      const data = buffer.lines.get(i)._data;
      hash.update(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    }
  return hash.digest("hex");
}

/** Fresh-process maximum-state measurement; a refusal is evidence, not exact-capability qualification. */
export async function qualifyProductionMemory(Terminal, Unicode11Addon) {
  const before = usage();
  const terminal = new Terminal({
    cols: 1000,
    rows: 500,
    scrollback: 5000,
    allowProposedApi: true,
    cursorBlink: true,
  });
  try {
    terminal.loadAddon(new Unicode11Addon());
    activateTerminalUnicodeProvider(terminal);
    for (let i = 0; i < 5500; i += 100)
      await new Promise((done) => terminal.write("x\r\n".repeat(Math.min(100, 5500 - i)), done));
    const buffer = terminal._core.buffers.normal;
    assert.equal(buffer.lines.length, 5500);
    // Nonuniform characters and independently varying foreground/background RGB in every cell.
    const attrs = terminal._core._inputHandler._curAttrData.clone();
    for (let row = 0; row < buffer.lines.length; row++) {
      const line = buffer.lines.get(row);
      for (let col = 0; col < 1000; col++) {
        const index = row * 1000 + col;
        attrs.fg = 0x3000000 | ((index * 17) & 0xffffff);
        attrs.bg = 0x3000000 | ((index * 29 + 7) & 0xffffff);
        line.setCellFromCodepoint(col, 33 + (index % 90), 1, attrs);
      }
    }
    const populated = usage();
    const original = digest(terminal);
    const estimate = estimateProductionCapture(terminal);
    assert.equal(estimate.words, 16_500_000);
    assert.throws(
      () => captureProductionState(terminal, parserProfile(terminal._core)),
      /capture budget exceeded/,
    );
    assert.equal(digest(terminal), original);
    const refused = usage();
    return {
      geometry: { cols: 1000, rows: 500, scrollback: 5000, populatedLines: buffer.lines.length },
      budgets: PRODUCTION_CHECKPOINT_BUDGET,
      estimate,
      measurements: { before, populated, refused },
      stateUnchanged: true,
      refusedBeforeProjection: true,
      reason:
        "Even numeric-array plus minimum wire plus materialized-cell lower bounds exceed the unchanged 128 MiB staging ceiling.",
      exactCapability: false,
    };
  } finally {
    terminal.dispose();
  }
}
