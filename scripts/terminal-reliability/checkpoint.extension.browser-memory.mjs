import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  verifyArtifacts,
  loadVerifiedHeadless,
  verifiedArtifactSource,
} from "./checkpoint.extension.artifacts.mjs";
import { referenceState } from "./checkpoint.extension.reference.mjs";

const directory = resolve(process.argv[2]);
const verified = await verifyArtifacts(directory);
if (!globalThis.gc) throw new Error("browser measurement requires --expose-gc");
const { Terminal } = loadVerifiedHeadless(verified);
const { chromium } = createRequire(new URL("../../apps/web/package.json", import.meta.url))(
  "playwright",
);
const source = new Terminal({ cols: 1000, rows: 500, scrollback: 5000, allowProposedApi: true });
const write = (data) => new Promise((done) => source.write(data, done));
const server = createServer((_request, response) => response.end("<!doctype html><body></body>"));
await new Promise((done, failed) => {
  server.once("error", failed);
  server.listen(0, "127.0.0.1", done);
});
let browser, checkpoint, rssTimer;
const report = {
  options: { cols: 1000, rows: 500, scrollback: 5000 },
  exactCapability: false,
  phases: [],
};
try {
  const row =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".repeat(17).slice(0, 1000) +
    "\r\n";
  for (let i = 0; i < 5500; i += 128) await write(row.repeat(Math.min(128, 5500 - i)));
  checkpoint = source.exportExperimentalCheckpoint();
  globalThis.gc();
  report.nodeSourceAndCheckpoint = process.memoryUsage();
  report.nodeHighWaterRssKiB = process.resourceUsage().maxRSS;
  report.checkpointBytes = checkpoint.byteLength;
  const expected = referenceState(source, false);
  const lineHashes = [
    source._core._bufferService.buffers.normal,
    source._core._bufferService.buffers.alt,
  ].map((buffer) =>
    Array.from({ length: buffer.lines.length }, (_, index) => {
      const line = buffer.lines.get(index);
      return createHash("sha256")
        .update(Buffer.from(line._data.buffer, line._data.byteOffset, line._data.byteLength))
        .digest("hex");
    }),
  );
  browser = await chromium.launch({ headless: true, args: ["--js-flags=--expose-gc"] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.addScriptTag({
    content: verifiedArtifactSource(verified, "browser"),
  });
  await page.addScriptTag({
    content: `globalThis.__bigbudReferenceState = ${referenceState.toString()}`,
  });
  const cdp = await page.context().newCDPSession(page);
  const system = await browser.newBrowserCDPSession();
  async function phase(name) {
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const { processInfo } = await system.send("SystemInfo.getProcessInfo");
    const processes = processInfo.map(({ id, type }) => ({
      id,
      type,
      rssKiB: Number(
        execFileSync("ps", ["-o", "rss=", "-p", String(id)], { encoding: "utf8" }).trim(),
      ),
    }));
    report.phases.push({ name, heap, processes });
  }
  await page.evaluate(
    (header) => {
      globalThis.target = new globalThis.Terminal({ cols: 2, rows: 1, allowProposedApi: true });
      globalThis.incoming = header;
      globalThis.importEvents = [];
      for (const event of ["onData", "onBell", "onTitleChange", "onResize"])
        if (typeof target[event] === "function")
          target[event]((value) => importEvents.push([event, value]));
    },
    { ...checkpoint, pages: [] },
  );
  await phase("fresh-browser-target");
  const { processInfo } = await system.send("SystemInfo.getProcessInfo");
  const rendererPids = processInfo
    .filter((info) => info.type === "renderer")
    .map((info) => info.id);
  report.rendererRssSampledPeakKiB = 0;
  report.rendererRssSamples = 0;
  const sampleRss = () => {
    const values = execFileSync("ps", ["-o", "rss=", "-p", rendererPids.join(",")], {
      encoding: "utf8",
    });
    const totalKiB = values
      .trim()
      .split(/\s+/)
      .reduce((sum, value) => sum + Number(value), 0);
    report.rendererRssSampledPeakKiB = Math.max(report.rendererRssSampledPeakKiB, totalKiB);
    report.rendererRssSamples++;
  };
  sampleRss();
  rssTimer = setInterval(() => {
    try {
      sampleRss();
    } catch (error) {
      report.rendererRssSamplingError = String(error);
      clearInterval(rssTimer);
    }
  }, 25);
  // Test transport has ONE <=48 KiB page in flight. Numeric JSON expansion is
  // confined to that page, not a per-cell full-state projection or parallel fanout.
  for (const bytes of checkpoint.pages)
    await page.evaluate((bytes) => incoming.pages.push(new Uint8Array(bytes)), Array.from(bytes));
  await phase("incoming-binary-pages");
  await page.evaluate(() => target.importExperimentalCheckpoint(incoming));
  await phase("fresh-import-plus-incoming-pages");
  const result = await page.evaluate(async (expectedHashes) => {
    const buffers = [
      target._core._bufferService.buffers.normal,
      target._core._bufferService.buffers.alt,
    ];
    for (let index = 0; index < buffers.length; index++) {
      if (buffers[index].lines.length !== expectedHashes[index].length)
        throw new Error("browser line count mismatch");
      for (let row = 0; row < buffers[index].lines.length; row++) {
        const line = buffers[index].lines.get(row);
        const digest = await crypto.subtle.digest("SHA-256", line._data);
        const actual = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
        if (actual !== expectedHashes[index][row])
          throw new Error(`independent browser raw-cell mismatch ${index}/${row}`);
        if (Object.keys(line._combined).length || Object.keys(line._extendedAttrs).length)
          throw new Error("unexpected maximum-fixture cell map");
      }
    }
    return {
      state: __bigbudReferenceState(target, false),
      importEvents,
      accounting: target.experimentalCheckpointAccounting(),
    };
  }, lineHashes);
  assert.deepEqual(result.state, expected);
  assert.deepEqual(result.importEvents, []);
  report.independentRawState =
    "passed, all 5500 normal-buffer line SHA-256 digests and selected metadata";
  report.accounting = result.accounting;
  await page.evaluate(() => {
    incoming.pages.length = 0;
    globalThis.incoming = null;
    const host = document.createElement("div");
    document.body.append(host);
    target.open(host);
    return new Promise((done) => requestAnimationFrame(done));
  });
  await phase("opened-browser-view-after-wire-pages-release");
  await page.evaluate(() => target.dispose());
  await phase("disposed-browser-view");
  assert.equal(report.rendererRssSamplingError, undefined, "renderer RSS sampler failed");
} finally {
  if (rssTimer) clearInterval(rssTimer);
  if (checkpoint) source.releaseExperimentalCheckpoint(checkpoint);
  source.dispose();
  if (browser) await browser.close();
  await new Promise((done) => server.close(done));
}
console.log(
  JSON.stringify(
    {
      ...report,
      limitation:
        "CDP live heap/backing-storage, phase RSS and 25ms sampled renderer RSS high-water, NOT an OS-enforced or guaranteed allocator peak. Test-only transport expansion is one page; production transfer/owner admission remains gated.",
    },
    null,
    2,
  ),
);
