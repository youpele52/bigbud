import { access, mkdtemp, readFile, rmdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  createCheckpointTestFixture,
  checkpointTestFixtureFromEnvironment,
  type CheckpointTestFixture,
} from "./terminal-reliability/checkpoint.extension.test-fixture.mjs";
import {
  hash,
  inputs,
  sourceManifest,
} from "./terminal-reliability/checkpoint.extension.artifacts.mjs";
import { executeOwnedNode } from "./lib/checkpoint-node-tests.process";
import { scriptsRoot } from "./lib/checkpoint-node-tests.inventory";
import { combinedCheckpointFailure } from "./lib/checkpoint-node-tests.errors";

let fixture: CheckpointTestFixture;
let parent: string;
beforeAll(async () => {
  parent = await mkdtemp(
    path.join(process.env.BIGBUD_CHECKPOINT_TEST_TMPDIR ?? tmpdir(), "bigbud-cold-fixture-parent-"),
  );
  await writeFile(path.join(parent, "keep"), "parent-owned sentinel");
  vi.stubGlobal("fetch", () => {
    throw new Error("Network disabled for fixture setup");
  });
  fixture = await createCheckpointTestFixture({ temporaryRoot: parent });
}, 75000);
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  vi.unstubAllGlobals();
  await fixture?.dispose();
  if (parent) {
    await rm(path.join(parent, "keep"), { force: true });
    await rmdir(parent);
  }
});

it("cleanup diagnostics retain both errors and the primary cause", () => {
  const primary = new Error("synthetic primary failure");
  const cleanup = new Error("synthetic cleanup failure");
  const combined = combinedCheckpointFailure(primary, cleanup, "owned cleanup failed");
  expect(combined.cause).toBe(primary);
  expect(combined.errors).toEqual([primary, cleanup]);
});

it("cold fixture comes only from exact installed vendor bundles and trusted current source/compiler", async () => {
  const root = JSON.parse(await readFile(path.join(scriptsRoot, "../package.json"), "utf8"));
  expect(fixture.toolchain.policy).toEqual({
    packageManager: root.packageManager,
    supported: root.engines.bun,
  });
  const version = await executeOwnedNode(["--version"], {
    command: process.env.BIGBUD_CHECKPOINT_BUN_BINARY ?? "bun",
    cwd: scriptsRoot,
    timeoutMs: 10000,
    maxBuffer: 4096,
  });
  expect(fixture.toolchain.version).toBe(version.stdout.trim());
  const manifest = JSON.parse(
    await readFile(path.join(fixture.directory, "manifest.json"), "utf8"),
  );
  expect(manifest.exactCapability).toBe(false);
  expect(manifest.sources).toEqual(sourceManifest());
  for (const kind of ["headless", "browser"] as const) {
    expect(hash(await readFile(path.join(fixture.directory, `${kind}.cjs`)))).toBe(inputs[kind]);
    expect(hash(await readFile(path.join(fixture.directory, `${kind}.experimental.cjs`)))).toBe(
      manifest.outputs[kind],
    );
  }
  expect(await readFile(path.join(parent, "keep"), "utf8")).toBe("parent-owned sentinel");
});

it("requires an explicit matching owned ticket, never a caller's cache or implicit trusted root", async () => {
  vi.stubEnv("BIGBUD_CHECKPOINT_FIXTURE", undefined);
  vi.stubEnv("BIGBUD_CHECKPOINT_FIXTURE_TICKET", undefined);
  await expect(checkpointTestFixtureFromEnvironment()).rejects.toThrow("Missing owned checkpoint");
  vi.stubEnv("BIGBUD_CHECKPOINT_FIXTURE", fixture.directory);
  vi.stubEnv("BIGBUD_CHECKPOINT_FIXTURE_TICKET", "0".repeat(64));
  await expect(checkpointTestFixtureFromEnvironment()).rejects.toThrow("Invalid owned checkpoint");
  vi.stubEnv("BIGBUD_CHECKPOINT_FIXTURE_TICKET", fixture.env.BIGBUD_CHECKPOINT_FIXTURE_TICKET);
  await expect(checkpointTestFixtureFromEnvironment()).resolves.toBe(fixture.directory);
});

it("the actual selected compiler enforces the declared support policy", async () => {
  const module = pathToFileURL(
    path.join(scriptsRoot, "terminal-reliability/checkpoint.extension.toolchain.mjs"),
  ).href;
  const source = `import assert from 'node:assert/strict';
    import { installedCompilerFingerprint } from ${JSON.stringify(module)};
    for (const version of ['1.3.8', '2.0.0', 'invalid'])
      assert.throws(() => installedCompilerFingerprint({ version, semver: Bun.semver }), /must satisfy declared/);
    assert.equal(installedCompilerFingerprint(Bun).version, Bun.version);
    console.log('declared compiler policy verified');`;
  const result = await executeOwnedNode(["--no-install", "--eval", source], {
    command: process.env.BIGBUD_CHECKPOINT_BUN_BINARY ?? "bun",
    cwd: scriptsRoot,
    timeoutMs: 10000,
    maxBuffer: 4096,
  });
  expect(result.stdout.trim()).toBe("declared compiler policy verified");
});

it("fresh owned cleanup is idempotent and preserves the supplied temp root", async () => {
  await fixture.dispose();
  await fixture.dispose();
  await expect(access(fixture.directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(parent, "keep"), "utf8")).toBe("parent-owned sentinel");
});
