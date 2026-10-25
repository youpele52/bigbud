import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyArtifacts, loadVerifiedHeadless } from "./checkpoint.extension.artifacts.mjs";
import { referenceState } from "./checkpoint.extension.reference.mjs";
import { digestPages } from "./checkpoint.extension.digest.mjs";

const directory = resolve(process.argv[2]);
const verified = await verifyArtifacts(directory);
if (!globalThis.gc) throw new Error("maximum-state measurement requires --expose-gc");
const { Terminal } = loadVerifiedHeadless(verified);
const write = (terminal, data) => new Promise((done) => terminal.write(data, done));
const point = () => ({ ...process.memoryUsage(), highWaterRssKiB: process.resourceUsage().maxRSS });

function independentDigest(terminal) {
  const hash = createHash("sha256").update(JSON.stringify(referenceState(terminal, false)));
  let backingBytes = 0,
    cells = 0;
  for (const buffer of [
    terminal._core._bufferService.buffers.normal,
    terminal._core._bufferService.buffers.alt,
  ]) {
    for (let i = 0; i < buffer.lines.length; i++) {
      const line = buffer.lines.get(i);
      hash.update(Buffer.from(line._data.buffer, line._data.byteOffset, line._data.byteLength));
      hash.update(
        JSON.stringify([line.length, line.isWrapped, line._combined, line._extendedAttrs]),
      );
      backingBytes += line._data.buffer.byteLength;
      cells += line.length;
    }
  }
  return { digest: hash.digest("hex"), backingBytes, cells };
}

async function runCase(options, adversarial = false) {
  globalThis.gc();
  const initial = point();
  const source = new Terminal({ ...options, allowProposedApi: true });
  const target = new Terminal({ cols: 2, rows: 1, allowProposedApi: true });
  let checkpoint, replacement;
  const report = { options, adversarial, initial, exactCapability: false };
  try {
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const row =
      alphabet.repeat(Math.ceil(options.cols / alphabet.length)).slice(0, options.cols) + "\r\n";
    for (let i = 0; i < options.rows + options.scrollback; i += 128)
      await write(source, row.repeat(Math.min(128, options.rows + options.scrollback - i)));
    globalThis.gc();
    report.source = point();
    report.sourceState = independentDigest(source);
    const began = performance.now();
    checkpoint = source.exportExperimentalCheckpoint();
    report.captured = point();
    report.checkpointBytes = checkpoint.byteLength;
    report.pages = checkpoint.pages.length;
    report.sourceAccounting = source.experimentalCheckpointAccounting();
    target.importExperimentalCheckpoint(checkpoint);
    report.imported = point();
    report.targetAccounting = target.experimentalCheckpointAccounting();
    const imported = independentDigest(target);
    assert.deepEqual(
      imported,
      report.sourceState,
      "maximum filled binary import must equal independent raw state",
    );
    assert(checkpoint.byteLength <= 128 * 1024 * 1024);
    assert(report.targetAccounting.stateReservedBytes + checkpoint.byteLength <= 128 * 1024 * 1024);
    report.filledCaptureAndImport = "passed";
    report.durationMs = performance.now() - began;
    if (adversarial) {
      // A legal dense cell state with all three planes nonuniform. This avoids
      // mistaking compressible plain text for universal maximum-state proof.
      const normal = source._core._bufferService.buffers.normal;
      for (let y = 0; y < normal.lines.length; y++) {
        const line = normal.lines.get(y);
        for (let x = 0; x < line.length; x++) {
          line._data[x * 3 + 1] = 0x02000000 | (x % 256);
          line._data[x * 3 + 2] = 0x02000000 | ((x + y) % 256);
        }
      }
      replacement = source.exportExperimentalCheckpoint();
      report.adversarialEncodedBytes = replacement.byteLength;
      assert.throws(() => target.importExperimentalCheckpoint(replacement), /budget/);
      assert.deepEqual(
        independentDigest(target),
        imported,
        "budget refusal partially mutated old target",
      );
      assert.equal(
        digestPages(checkpoint.pages),
        checkpoint.digest,
        "budget failure changed old checkpoint",
      );
      report.adversarialRestore =
        "blocked by unchanged 128 MiB staging ceiling; old target/checkpoint intact";
      report.afterAdversarialRefusal = point();
    }
    await write(source, "\x1b[6n");
    await write(target, "\x1b[6n");
  } finally {
    if (replacement) source.releaseExperimentalCheckpoint(replacement);
    if (checkpoint) source.releaseExperimentalCheckpoint(checkpoint);
    source.dispose();
    target.dispose();
    report.releasedAccounting = source.experimentalCheckpointAccounting();
    assert.equal(report.releasedAccounting.profileReservedBytes, 0, "reservation leak");
  }
  return report;
}

const configurations = [
  { cols: 500, rows: 500, scrollback: 10000 },
  { cols: 1000, rows: 500, scrollback: 5000 },
];
const childIndex = process.argv[3];
if (childIndex !== undefined) {
  const options = configurations[Number(childIndex)];
  if (!options) throw new Error("unknown isolated maximum-state case");
  console.log(JSON.stringify(await runCase(options, options.cols === 1000)));
} else {
  const report = configurations.map((_, index) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["--expose-gc", fileURLToPath(import.meta.url), directory, String(index)],
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
      ),
    ),
  );
  console.log(
    JSON.stringify(
      {
        report,
        exactCapability: false,
        accounting:
          "128 MiB encoded, 128 MiB incoming+decoded restore staging, 128 MiB estimated state, 512 MiB aggregate reservations; immutable source/old/replacement slots charged separately",
        limitation:
          "conservative JS allocation estimates are not allocator instrumentation; measured RSS includes engine/old-source/new-import/encoded pages. Dense independently colored maximum state still blocks exact readiness, not permission to raise limits.",
      },
      null,
      2,
    ),
  );
}
