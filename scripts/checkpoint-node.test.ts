import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import {
  createCheckpointTestFixture,
  type CheckpointTestFixture,
} from "./terminal-reliability/checkpoint.extension.test-fixture.mjs";
import {
  checkpointNodeTestFiles,
  discoverCheckpointNodeTests,
} from "./lib/checkpoint-node-tests.inventory";
import {
  checkpointNodeCleanupMs,
  checkpointNodeTimeoutMs,
  runCheckpointNodeTest,
} from "./lib/checkpoint-node-tests";

const cleanup: string[] = [];
let fixture: CheckpointTestFixture;
beforeAll(async () => {
  fixture = await createCheckpointTestFixture();
  console.info(
    `Fresh checkpoint fixture: build=${fixture.build} compiler=${fixture.toolchain.version}`,
  );
}, 75_000);
afterAll(async () => {
  await fixture?.dispose();
});
afterEach(async () => {
  for (const directory of cleanup.splice(0).toReversed())
    await rm(directory, { recursive: true, force: true });
});
async function syntheticHarness(source: string) {
  const directory = await mkdtemp(
    path.join(process.env.BIGBUD_CHECKPOINT_TEST_TMPDIR ?? tmpdir(), "bigbud-node-test-wrapper-"),
  );
  cleanup.push(directory);
  const file = path.join(directory, "synthetic harness.test.mjs");
  await writeFile(file, source);
  return { directory, file };
}

it.each(discoverCheckpointNodeTests())(
  "executes standalone Node checkpoint harness %s",
  async (file) => {
    const counts = await runCheckpointNodeTest(file, { env: { ...process.env, ...fixture.env } });
    expect(counts.tests).toBeGreaterThan(0);
    console.info(`Node checkpoint ${path.basename(file)}: ${JSON.stringify(counts)}`);
  },
  checkpointNodeTimeoutMs + checkpointNodeCleanupMs + 5_000,
);

it("runs actual Node tests outside the package directory, not Bun or a successful empty file", async () => {
  const { file } = await syntheticHarness(`
    import assert from 'node:assert/strict';
    import { test } from 'node:test';
    test('actual Node', () => {
      assert.equal(process.release.name, 'node');
      assert.equal(process.versions.bun, undefined);
    });
    test('second actual case', () => assert.equal(2 + 2, 4));
  `);
  expect(await runCheckpointNodeTest(file)).toEqual({
    tests: 2,
    pass: 2,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  });
  await writeFile(file, "export {};\n");
  await expect(runCheckpointNodeTest(file)).rejects.toThrow("did not complete every test");
});

it("propagates Node assertion failure with bounded useful diagnostics", async () => {
  const { file } = await syntheticHarness(`
    import assert from 'node:assert/strict';
    import { test } from 'node:test';
    test('synthetic failure', () => assert.fail('synthetic checkpoint failure'));
  `);
  await expect(runCheckpointNodeTest(file)).rejects.toThrow("synthetic checkpoint failure");
});

it("fails missing or unexpected inventory instead of silently excluding tests", async () => {
  const { directory } = await syntheticHarness("export {};\n");
  await expect(runCheckpointNodeTest(path.join(directory, "missing.test.mjs"))).rejects.toThrow(
    "failed",
  );
  expect(() => discoverCheckpointNodeTests(directory)).toThrow("inventory mismatch");
  for (const name of checkpointNodeTestFiles)
    await writeFile(path.join(directory, name), "export {};\n");
  expect(discoverCheckpointNodeTests(directory)).toEqual(
    checkpointNodeTestFiles.map((name) => path.join(directory, name)),
  );
  await writeFile(
    path.join(directory, "checkpoint.extension.unregistered.test.mjs"),
    "export {};\n",
  );
  expect(() => discoverCheckpointNodeTests(directory)).toThrow("inventory mismatch");
});

it("bounds a hung Node harness and an oversized output stream", async () => {
  const { file } = await syntheticHarness(`
    import { test } from 'node:test';
    test('synthetic hang', () => new Promise(() => {}));
    setInterval(() => {}, 100);
  `);
  await expect(runCheckpointNodeTest(file, { timeoutMs: 500 })).rejects.toMatchObject({
    code: "NODE_TIMEOUT",
  });
  await writeFile(
    file,
    `import { test } from 'node:test'; test('output', () => console.log('x'.repeat(16384)));\n`,
  );
  await expect(runCheckpointNodeTest(file, { maxBuffer: 512 })).rejects.toThrow("maxBuffer");
}, 10_000);
