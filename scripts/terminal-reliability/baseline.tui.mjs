import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { buildFrame, splitIntoReads } from "./baseline.tui.frames.mjs";
import { buildTuiPage } from "./baseline.tui.page.mjs";

// Opt-in TUI baseline: synthetic DEC 2026 frames over loopback WS into real browser xterm.
// Usage: bun run scripts/terminal-reliability/baseline.tui.mjs <dom|webgl> <direct|bigbud> <diff|full> [busy]
// BIGBUD_TUI_LANE_ENTRY=<file> bundles an alternative lane entry (A/B against another batcher).
// BIGBUD_TUI_GPU=1 asks headless Chromium for hardware WebGL; check glRenderer in the report.
// BIGBUD_TUI_CREDIT=0 disables the credit window (unbounded delivery, today's production transport).
if (typeof Bun === "undefined")
  throw new Error("Run with bun run scripts/terminal-reliability/baseline.tui.mjs");
const [mode = "dom", lane = "bigbud", profile = "diff", busyFlag] = process.argv.slice(2);
if (!["dom", "webgl"].includes(mode)) throw new Error("Expected mode dom or webgl");
if (!["direct", "bigbud"].includes(lane)) throw new Error("Expected lane direct or bigbud");
if (!["diff", "full"].includes(profile)) throw new Error("Expected profile diff or full");
const busy = busyFlag === "busy";
const frameCount = 300;
const frameIntervalMs = 1000 / 60;
// O5's per-subscriber credit window: unparsed output in flight is bounded; the rest waits upstream.
const creditWindowChars = process.env.BIGBUD_TUI_CREDIT === "0" ? Infinity : 256 * 1024;

const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { chromium } = requireWeb("playwright");
const terminalBundle = readFileSync(requireWeb.resolve("@xterm/xterm"));
const addonBundle = readFileSync(requireWeb.resolve("@xterm/addon-webgl"));
const laneEntry =
  process.env.BIGBUD_TUI_LANE_ENTRY ?? new URL("./baseline.tui.lane.ts", import.meta.url).pathname;
const laneBuild = await Bun.build({
  entrypoints: [laneEntry],
  target: "browser",
  external: ["@xterm/xterm"],
});
if (!laneBuild.success) throw new Error(laneBuild.logs.map(String).join("\n"));
const laneBundle = await laneBuild.outputs[0].text();
const html = buildTuiPage({ mode, lane, busy, expectedFrames: frameCount });
const assets = { "/xterm.js": terminalBundle, "/webgl.js": addonBundle, "/lane.js": laneBundle };

function startProducer(socket) {
  const backlog = [];
  let backlogChars = 0;
  let backlogMaxChars = 0;
  let sentChars = 0;
  let produced = 0;
  let done = false;
  const pump = () => {
    while (backlog.length > 0 && sentChars - socket.data.ackedChars < creditWindowChars) {
      const read = backlog.shift();
      backlogChars -= read.length;
      sentChars += read.length;
      socket.send(read);
    }
    if (done && backlog.length === 0 && !socket.data.finished) {
      socket.data.finished = true;
      socket.send(`__done__:${backlogMaxChars}`);
    }
  };
  socket.data.pump = pump;
  const timer = setInterval(() => {
    for (const read of splitIntoReads(buildFrame(profile, produced))) {
      backlog.push(read);
      backlogChars += read.length;
    }
    backlogMaxChars = Math.max(backlogMaxChars, backlogChars);
    if (++produced >= frameCount) {
      clearInterval(timer);
      done = true;
    }
    pump();
  }, frameIntervalMs);
}

let server;
let browser;
try {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/output") {
        if (server.upgrade(request, { data: { ackedChars: 0, finished: false, pump: null } }))
          return;
        return new Response("Upgrade required", { status: 400 });
      }
      const asset = assets[path];
      if (asset) return new Response(asset, { headers: { "content-type": "text/javascript" } });
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
    websocket: {
      open: startProducer,
      message(socket, message) {
        const text = String(message);
        if (!text.startsWith("ack:")) return;
        socket.data.ackedChars = Math.max(socket.data.ackedChars, Number(text.slice(4)));
        socket.data.pump?.();
      },
    },
  });
  const gpuArgs = ["--enable-gpu", "--ignore-gpu-blocklist", "--use-angle=metal"];
  browser = await chromium.launch({
    headless: true,
    args: process.env.BIGBUD_TUI_GPU === "1" ? gpuArgs : [],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.waitForFunction(() => window.report || window.failure, null, { timeout: 120_000 });
  const result = await page.evaluate(() => ({ report: window.report, failure: window.failure }));
  if (result.failure) throw new Error(result.failure);
  const machine = {
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpu: cpus()[0]?.model,
  };
  console.log(
    JSON.stringify({
      machine,
      runtime: { bun: Bun.version, browser: browser.version() },
      profile,
      laneEntry: process.env.BIGBUD_TUI_LANE_ENTRY ? "override" : "production",
      creditWindowChars: Number.isFinite(creditWindowChars) ? creditWindowChars : null,
      ...result.report,
      limitations: [
        "isolated synthetic WS/xterm, not bigbud PTY/production WS",
        "check glRenderer: headless Chromium may use software WebGL",
      ],
    }),
  );
} finally {
  await browser?.close();
  await server?.stop(true);
}
