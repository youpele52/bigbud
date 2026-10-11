import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { platform, arch, release, cpus } from "node:os";

// Opt-in, isolated loopback WS → real browser xterm. Synthetic output, no existing app sessions.
if (typeof Bun === "undefined")
  throw new Error("Run with bun run scripts/terminal-reliability/baseline.mjs");
const mode = process.argv[2] ?? "dom";
if (!["dom", "webgl"].includes(mode)) throw new Error("Expected dom or webgl");
const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { chromium } = requireWeb("playwright");
const terminalBundle = readFileSync(requireWeb.resolve("@xterm/xterm"));
const addonBundle = readFileSync(requireWeb.resolve("@xterm/addon-webgl"));
const samples = 200;
const payload = "synthetic-output 😀\r\n".repeat(100);
const html = `<!doctype html><html><body><div id="terminal" style="width:800px;height:500px"></div>
<script src="/xterm.js"></script><script src="/webgl.js"></script><script>
(async () => {
  const terminal = new Terminal({cols:80, rows:24, scrollback:100});
  terminal.open(document.querySelector('#terminal'));
  let activeMode = 'dom';
  if (${JSON.stringify(mode)} === 'webgl') {
    const addon = new WebglAddon.WebglAddon();
    addon.onContextLoss(() => { addon.dispose(); activeMode = 'dom'; });
    terminal.loadAddon(addon); activeMode = 'webgl';
  }
  const callbackMs = [], frameMs = []; let lastFrame = performance.now(), running = true;
  function frame(now) { frameMs.push(now-lastFrame); lastFrame=now; if (running) requestAnimationFrame(frame); }
  requestAnimationFrame(frame);
  const socket = new WebSocket('ws://' + location.host + '/output');
  let next = 0, totalBytes = 0; const started = performance.now();
  socket.onmessage = (event) => {
    const record = JSON.parse(event.data);
    if (record.sequence !== next++) throw new Error('Synthetic WS order mismatch');
    totalBytes += new TextEncoder().encode(record.data).length;
    const start = performance.now();
    terminal.write(record.data, () => {
      callbackMs.push(performance.now()-start);
      if (next === ${samples}) {
        running=false;
        const percentile = (values, p) => values.sort((a,b)=>a-b)[Math.floor((values.length-1)*p)] ?? null;
        window.report = {requestedMode:${JSON.stringify(mode)},activeMode,samples:next,totalBytes,elapsedMs:performance.now()-started,
          callbackP50Ms:percentile(callbackMs,.5),callbackP95Ms:percentile(callbackMs,.95),callbackP99Ms:percentile(callbackMs,.99),frameP95Ms:percentile(frameMs,.95),
          userAgent:navigator.userAgent,devicePixelRatio:devicePixelRatio};
        socket.close(); terminal.dispose();
      } else socket.send(String(next));
    });
  };
})().catch(error => { window.failure = String(error); });
</script></body></html>`;
let server;
let browser;
try {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/output") {
        if (server.upgrade(request, { data: { nextSequence: 1 } })) return;
        return new Response("Upgrade required", { status: 400 });
      }
      if (path === "/xterm.js")
        return new Response(terminalBundle, { headers: { "content-type": "text/javascript" } });
      if (path === "/webgl.js")
        return new Response(addonBundle, { headers: { "content-type": "text/javascript" } });
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
    websocket: {
      maxPayloadLength: 1024,
      backpressureLimit: 64 * 1024,
      closeOnBackpressureLimit: true,
      open(socket) {
        socket.send(JSON.stringify({ sequence: 0, data: payload }));
      },
      message(socket, message) {
        const sequence = Number(message);
        if (
          !Number.isInteger(sequence) ||
          sequence !== socket.data.nextSequence ||
          sequence >= samples
        ) {
          socket.close();
          return;
        }
        socket.data.nextSequence++;
        socket.send(JSON.stringify({ sequence, data: payload }));
      },
    },
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.waitForFunction(() => window.report || window.failure, null, { timeout: 30000 });
  const result = await page.evaluate(() => ({ report: window.report, failure: window.failure }));
  if (result.failure) throw new Error(result.failure);
  console.log(
    JSON.stringify(
      {
        machine: {
          platform: platform(),
          arch: arch(),
          osRelease: release(),
          cpu: cpus()[0]?.model,
        },
        runtime: { bun: Bun.version, browser: browser.version() },
        ...result.report,
        limitations: [
          "isolated synthetic WS/xterm, not bigbud PTY/production WS",
          "GPU/driver and power mode not independently identified",
          "headless browser may use software WebGL; no native rollout proof",
          "no speedup comparison claimed",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server?.stop(true);
}
