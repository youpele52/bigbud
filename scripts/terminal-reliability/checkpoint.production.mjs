// Called by the pinned-artifact fetcher; synthetic qualification only, never a recovery codec.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { activateTerminalUnicodeProvider } from "../../apps/web/src/components/terminal/terminalUnicodeProvider.ts";
import { captureState } from "./checkpoint.extension.state.mjs";
import { qualifyProductionState } from "./checkpoint.production.qualify.mjs";
import { qualifyProductionMemory } from "./checkpoint.production.memory.mjs";

const input = JSON.parse(readFileSync(process.argv[2] ?? 0, "utf8"));
assert.equal(input.version, "6.1.0-beta.304");
assert.equal(
  createHash("sha256").update(input.source).digest("hex"),
  "cb1bf2e5ccfcb38a9450a59e853725904ce497a97e7b829d98bca1081f9b7e0b",
  "unreviewed production headless bundle",
);
const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const browserPackage = JSON.parse(
  readFileSync(requireWeb.resolve("@xterm/xterm/package.json"), "utf8"),
);
assert.equal(browserPackage.version, input.version, "browser/headless version mismatch");
const { Unicode11Addon } = requireWeb("@xterm/addon-unicode11");
const module = { exports: {} };
runInNewContext(input.source, {
  module,
  exports: module.exports,
  process,
  self: {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console,
  performance,
  Uint8Array,
  TextDecoder,
  TextEncoder,
  structuredClone,
});
const { Terminal } = module.exports;
if (process.argv[3] === "--memory") {
  console.log(JSON.stringify(await qualifyProductionMemory(Terminal, Unicode11Addon), null, 2));
  process.exit(0);
}
const terminal = new Terminal({ cols: 40, rows: 10, scrollback: 5000, allowProposedApi: true });
const replies = [];
const colors = [];
const write = (data) => new Promise((resolve) => terminal.write(data, resolve));
try {
  terminal.loadAddon(new Unicode11Addon());
  activateTerminalUnicodeProvider(terminal);
  assert.equal(terminal.unicode.activeVersion, "bigbud-11-zwj");
  // The real production provider must survive split ZWJ and parser chunks, not just plain ASCII.
  await write("👩\u200d");
  await write("👩\u200d👧\u200d👦");
  assert.equal(terminal.buffer.active.cursorX, 2);
  await write("\x1b[?1049h\x1b[H\x1b[?2004h\x1b[3");
  await write("2mTUI");
  assert.equal(terminal.buffer.active.type, "alternate");
  assert.equal(terminal.modes.bracketedPasteMode, true);
  assert.equal(terminal.buffer.active.getLine(0).getCell(0).getFgColor(), 2);
  terminal.onData((data) => replies.push(data));
  // Private observation only: no extra handler is installed to manufacture headless support.
  terminal._core._inputHandler.onColor((event) => colors.push(...event));
  await write("\x1b[6n");
  assert.equal(replies.length, 1, "headless cursor query should reply");
  replies.length = 0;
  await write("\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]4;1;?\x1b\\");
  assert.equal(colors.length, 3, "parser should recognize all three color queries");
  assert.deepEqual(replies, [], "stock headless does not own browser theme/color replies");
  // Even the old selected-state codec is not a drop-in upgrade. Keep its guards intact.
  assert.equal(terminal._core.coreMouseService, undefined);
  assert.ok(terminal._core.mouseStateService);
  assert.throws(() => captureState(terminal._core), TypeError);
  const continuation = await qualifyProductionState(Terminal, Unicode11Addon);
  console.log(
    JSON.stringify(
      {
        version: input.version,
        archiveSha256: input.archiveSha256,
        bundleSha256: input.bundleSha256,
        unicode: terminal.unicode.activeVersion,
        splitUnicodeAndParser: "passed",
        alternateScreenAndPasteMode: "passed",
        cursorResponse: "passed",
        colorQueriesParsed: colors.length,
        colorResponses: replies.length,
        exactCheckpointCapability: false,
        existingCheckpointSchemaCompatible: false,
        mouseStateServiceChanged: true,
        continuation,
        palettePolicy: "last-focused-view; retain last palette while detached",
        blocker:
          "Gate closed: tested malformed imports are transactional, but product-maximum capture is budget-refused and complete hostile/state/profile coverage is unqualified.",
      },
      null,
      2,
    ),
  );
} finally {
  terminal.dispose();
}
