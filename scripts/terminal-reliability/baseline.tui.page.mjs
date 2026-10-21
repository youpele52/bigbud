import { TUI_COLS, TUI_ROWS } from "./baseline.tui.frames.mjs";

// In-page measurement: ESU arrival → next xterm render, painted renders/s, lane failures.
// Parsed output is acknowledged to the producer, which keeps a bounded credit window (O5 model).
export function buildTuiPage({ mode, lane, busy, expectedFrames }) {
  const config = JSON.stringify({
    mode,
    lane,
    busy,
    expectedFrames,
    cols: TUI_COLS,
    rows: TUI_ROWS,
  });
  return `<!doctype html><html><body style="margin:0"><div id="terminal" style="width:1600px;height:900px"></div>
<script src="/xterm.js"></script><script src="/webgl.js"></script><script src="/lane.js"></script><script>
(async () => {
  const config = ${config};
  const probe = document.createElement('canvas').getContext('webgl2');
  const debugInfo = probe && probe.getExtension('WEBGL_debug_renderer_info');
  const glRenderer = debugInfo ? probe.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : (probe ? 'masked' : 'none');
  const terminal = new Terminal({ cols: config.cols, rows: config.rows, scrollback: 1000, fontSize: 12 });
  terminal.open(document.querySelector('#terminal'));
  let activeMode = 'dom';
  if (config.mode === 'webgl') {
    const addon = new WebglAddon.WebglAddon();
    addon.onContextLoss(() => { addon.dispose(); activeMode = 'dom-after-loss'; });
    terminal.loadAddon(addon); activeMode = 'webgl';
  }
  const socket = new WebSocket('ws://' + location.host + '/output');
  let parsedChars = 0; let ackScheduled = false;
  const credit = (chars) => {
    parsedChars += chars;
    if (ackScheduled) return;
    ackScheduled = true;
    setTimeout(() => { ackScheduled = false; socket.send('ack:' + parsedChars); }, 0);
  };
  // Every lane writes through this proxy so credit always means "parsed by xterm".
  const crediting = { write: (data, done) => terminal.write(data, () => { credit(data.length); done && done(); }) };
  const laneApi = config.lane === 'direct' ? null : window.createBigbudLane(crediting);
  const write = laneApi ? (data) => laneApi.write(data) : (data) => crediting.write(data);
  const renders = [];
  terminal.onRender(() => renders.push(performance.now()));
  if (config.busy) setInterval(() => { const until = performance.now() + 30; while (performance.now() < until) {} }, 100);
  const frameEnds = []; let messages = 0; let started = null; let producerBacklogMaxChars = 0;
  socket.onmessage = (event) => {
    started ??= performance.now();
    if (event.data.startsWith('__done__')) {
      producerBacklogMaxChars = Number(event.data.slice(9));
      setTimeout(finish, 1500);
      return;
    }
    messages++;
    if (event.data.includes('\\x1b[?2026l')) frameEnds.push(performance.now());
    write(event.data);
  };
  function percentile(values, p) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? Math.round(sorted[Math.floor((sorted.length - 1) * p)] * 10) / 10 : null;
  }
  function finish() {
    const latencies = []; let unpainted = 0; let cursor = 0;
    for (const end of frameEnds) {
      while (cursor < renders.length && renders[cursor] < end) cursor++;
      if (cursor < renders.length) latencies.push(renders[cursor] - end); else unpainted++;
    }
    const elapsedS = ((renders.at(-1) ?? performance.now()) - started) / 1000;
    window.report = {
      requestedMode: config.mode, activeMode, glRenderer, lane: config.lane, busyMainThread: config.busy,
      framesSent: config.expectedFrames, framesReceived: frameEnds.length, messages, unpaintedFrames: unpainted,
      rendersPerSecond: Math.round(renders.length / Math.max(elapsedS, 0.001)),
      frameToPaintP50Ms: percentile(latencies, 0.5), frameToPaintP95Ms: percentile(latencies, 0.95),
      frameToPaintMaxMs: percentile(latencies, 1), producerBacklogMaxChars,
      laneFailure: laneApi ? laneApi.failure : null,
    };
    terminal.dispose();
  }
})().catch((error) => { window.failure = String(error && error.stack || error); });
</script></body></html>`;
}
