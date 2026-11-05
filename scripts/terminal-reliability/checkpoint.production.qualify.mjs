import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { activateTerminalUnicodeProvider } from "../../apps/web/src/components/terminal/terminalUnicodeProvider.ts";
import {
  captureProductionState,
  restoreProductionState,
  parserProfile,
} from "./checkpoint.production.state.mjs";
import { attachHeadlessPalette } from "./checkpoint.production.palette.mjs";
import { productionFixtures, productionOracle } from "./checkpoint.production.fixtures.mjs";
import { qualifyProductionRefusals } from "./checkpoint.production.refusals.mjs";

const write = (terminal, data) =>
  new Promise((done) => terminal.write(Array.isArray(data) ? Uint8Array.from(data) : data, done));
const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));

/** Cross-realm synthetic continuation tests; no installed dependency or running terminal is patched. */
export async function qualifyProductionState(Terminal, Unicode11Addon) {
  const browserPath = resolve(
    dirname(requireWeb.resolve("@xterm/xterm/package.json")),
    "lib/xterm.mjs",
  );
  const browserSha256 = createHash("sha256").update(readFileSync(browserPath)).digest("hex");
  assert.equal(
    browserSha256,
    "b9d55c3896ab69b6358c13feed9da79f9054620f25491ad42a99bb01a4d47d1f",
    "unreviewed browser input",
  );
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL("checkpoint.production.browser.mjs", import.meta.url))],
    target: "browser",
    write: false,
    plugins: [
      {
        name: "production-xterm-pair",
        setup(builder) {
          builder.onResolve({ filter: /^@xterm\/xterm$/ }, () => ({
            path: browserPath,
          }));
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "browser harness build failed");
  const js = await build.outputs[0].text();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      return new URL(request.url).pathname === "/harness.js"
        ? new Response(js, { headers: { "Content-Type": "text/javascript" } })
        : new Response('<!doctype html><script type="module" src="/harness.js"></script>', {
            headers: { "Content-Type": "text/html" },
          });
    },
  });
  let browser;
  try {
    const { chromium } = requireWeb("playwright");
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.waitForFunction(() => Boolean(globalThis.__productionCheckpoint));
    const seed = await page.evaluate(() => globalThis.__productionCheckpoint.seed());
    const create = () => {
      const terminal = new Terminal({
        cols: 20,
        rows: 6,
        scrollback: 5000,
        cursorBlink: true,
        allowProposedApi: true,
      });
      terminal.loadAddon(new Unicode11Addon());
      activateTerminalUnicodeProvider(terminal);
      const palette = attachHeadlessPalette(terminal, seed);
      const replies = [];
      terminal.onData((data) => replies.push(data));
      return {
        terminal,
        palette,
        replies,
        dispose() {
          palette.dispose();
          terminal.dispose();
        },
      };
    };
    const results = [];
    for (const fixture of productionFixtures) {
      const source = create();
      const restored = create();
      try {
        const profile = parserProfile(source.terminal._core);
        await write(source.terminal, fixture.prefix);
        const checkpoint = captureProductionState(source.terminal, profile);
        const palette = source.palette.capture();
        restoreProductionState(restored.terminal, checkpoint, profile);
        restored.palette.restore(palette);
        assert.deepEqual(restored.replies, [], "silent import");
        source.replies.length = 0;
        await write(source.terminal, fixture.suffix);
        await write(restored.terminal, fixture.suffix);
        const expected = {
          state: productionOracle(source.terminal),
          replies: source.replies.slice(),
          palette: source.palette.capture(),
        };
        assert.deepEqual(productionOracle(restored.terminal), expected.state, fixture.name);
        assert.deepEqual(restored.replies, expected.replies, fixture.name);
        assert.deepEqual(restored.palette.capture(), expected.palette, fixture.name);
        results.push(
          await page.evaluate((input) => globalThis.__productionCheckpoint.run(input), {
            fixture,
            checkpoint,
            palette,
            expected,
          }),
        );
      } finally {
        source.dispose();
        restored.dispose();
      }
    }
    const policy = create();
    try {
      const changed = seed.slice();
      changed[257] = 0x112233;
      policy.palette.focus("view-a", seed);
      policy.palette.focus("view-b", changed);
      assert.equal(policy.palette.update("view-a", seed), false);
      policy.palette.detach("view-b");
      await write(policy.terminal, "\x1b]11;?\x1b\\");
      assert.deepEqual(policy.replies, ["\x1b]11;rgb:1111/2222/3333\x1b\\"]);
    } finally {
      policy.dispose();
    }
    const refusals = await qualifyProductionRefusals(create);
    const browserRefusals = await page.evaluate(() => globalThis.__productionCheckpoint.refusals());
    return {
      refusals,
      browserSha256,
      browserRefusals,
      cases: results.length,
      results,
      lastFocusedPalettePolicy: "passed",
      exactCapability: false,
    };
  } finally {
    await browser?.close();
    server.stop(true);
  }
}
