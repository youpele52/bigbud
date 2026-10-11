import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { checkpointFixtures, continuationFixtures } from "./checkpoint.fixtures.mjs";
import { BoundedReplayReference } from "./checkpoint.prototype.mjs";

const input = JSON.parse(readFileSync(0, "utf8"));
function load(source) {
  const module = { exports: {} };
  runInNewContext(source, {
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
  });
  return module.exports;
}
const { Terminal } = load(input.headless);
const { SerializeAddon } = load(input.serialize);
const options = { cols: 20, rows: 6, scrollback: 100, allowProposedApi: true };
const write = (terminal, data) => new Promise((resolve) => terminal.write(data, resolve));
function state(terminal) {
  const buffer = terminal.buffer.active;
  return {
    cursor: [buffer.cursorX, buffer.cursorY],
    lines: Array.from({ length: buffer.length }, (_, i) =>
      buffer.getLine(i).translateToString(true),
    ),
  };
}
const results = [];
for (const fixture of checkpointFixtures) {
  const a = new Terminal(options);
  const b = new Terminal(options);
  try {
    const addon = new SerializeAddon();
    a.loadAddon(addon);
    await write(a, fixture.prefix);
    await write(b, addon.serialize());
    await write(a, fixture.suffix);
    await write(b, fixture.suffix);
    assert.notDeepEqual(state(a), state(b), fixture.name);
    assert.deepEqual([state(a).cursor, state(b).cursor], fixture.cursor);
    results.push({
      fixture: fixture.name,
      serializeExact: false,
      observedCursors: [state(a).cursor, state(b).cursor],
    });
  } finally {
    a.dispose();
    b.dispose();
  }
}
for (const fixture of continuationFixtures) {
  const a = new Terminal(options);
  const b = new Terminal(options);
  try {
    const replay = new BoundedReplayReference();
    replay.write(fixture.prefix);
    await write(a, fixture.prefix);
    await replay.restore(b);
    await write(a, fixture.suffix);
    await write(b, fixture.suffix);
    a.resize(17, 8);
    b.resize(17, 8);
    assert.deepEqual(state(a), state(b), fixture.name);
  } finally {
    a.dispose();
    b.dispose();
  }
}
const decoderA = new Terminal(options);
const decoderB = new Terminal(options);
try {
  const replay = new BoundedReplayReference();
  const prefix = Uint8Array.from([0xf0, 0x9f]);
  replay.write(prefix);
  await write(decoderA, prefix);
  await replay.restore(decoderB);
  const suffix = Uint8Array.from([0x98, 0x80]);
  await write(decoderA, suffix);
  await write(decoderB, suffix);
  assert.deepEqual(state(decoderA), state(decoderB));
} finally {
  decoderA.dispose();
  decoderB.dispose();
}
assert.throws(() => new BoundedReplayReference(3).write("overflow"), /pause source/);
// Continuation matching while all source operations remain retained does not prove bounded cold recovery.
const terminal = new Terminal(options);
const latencies = [];
try {
  for (let i = 0; i < 100; i++) {
    const start = performance.now();
    await write(terminal, "synthetic-output\r\n".repeat(100));
    latencies.push(performance.now() - start);
  }
} finally {
  terminal.dispose();
}
latencies.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      inputs: input.hashes,
      serializeCounterexamples: results,
      replayPrototype: {
        fixtures: continuationFixtures.length + 1,
        limitFailure: "verified",
        exactCheckpoint: false,
        historicalSideEffectsSuppressed: false,
      },
      syntheticHeadlessBaseline: {
        samples: latencies.length,
        p50Ms: latencies[50],
        p95Ms: latencies[95],
        p99Ms: latencies[99],
        renderer: "headless",
        websocket: false,
      },
      exactRecoveryGate: "closed",
    },
    null,
    2,
  ),
);
