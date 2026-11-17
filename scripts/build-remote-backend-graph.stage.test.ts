import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { verifyBackendGraph } from "../apps/server/src/remote-backend/backendGraph.ts";
import {
  assertNoLifecycleScripts,
  auditSkippedInstallScripts,
  extractNodeRuntime,
  NODE_RUNTIME_PINS,
  npmCiArgs,
  prunePlan,
  sha256File,
} from "./build-remote-backend-graph.externals.ts";
import {
  cleanupGraphFixtures,
  nodeTarball,
  privateBase,
  signingKey,
  writeTree,
} from "./build-remote-backend-graph.fixture.ts";
import {
  bundledPackagesFromRegions,
  collectPackageNotices,
} from "./build-remote-backend-graph.notices.ts";
import { stageRemoteBackendGraph } from "./build-remote-backend-graph.stage.ts";

afterEach(cleanupGraphFixtures);
const target = "aarch64-unknown-linux-gnu" as const;
const externals = join(import.meta.dirname, "remote-backend-graph");

it("stage_rejects_lifecycle_scripts", async () => {
  expect(() => assertNoLifecycleScripts({ scripts: { postinstall: "node evil.js" } })).toThrow(
    "must not declare scripts (postinstall)",
  );
  expect(() => assertNoLifecycleScripts({ scripts: { build: "tsc" } })).toThrow();
  expect(() =>
    auditSkippedInstallScripts({
      packages: { "": {}, "node_modules/new-native": { hasInstallScript: true } },
    }),
  ).toThrow("Unreviewed install script in graph externals: new-native.");
  expect(npmCiArgs(target, "/empty")).toEqual(
    expect.arrayContaining([
      "ci",
      "--ignore-scripts",
      "--omit=dev",
      "--os=linux",
      "--cpu=arm64",
      "--libc=glibc",
    ]),
  );
  // The checked-in pins pass the same gates the stage applies before npm runs.
  const manifest = JSON.parse(await readFile(join(externals, "package.json"), "utf8"));
  assertNoLifecycleScripts(manifest);
  expect(Object.values(manifest.dependencies as Record<string, string>)).toEqual(
    expect.arrayContaining(["1.0.28", "1.4.0"]),
  );
  const lock = JSON.parse(await readFile(join(externals, "package-lock.json"), "utf8"));
  expect(lock.lockfileVersion).toBe(3);
  expect(auditSkippedInstallScripts(lock)).toEqual(["@google/genai", "koffi", "protobufjs"]);
  for (const [path, entry] of Object.entries(
    lock.packages as Record<string, { integrity?: string }>,
  ))
    if (path) expect(entry.integrity).toMatch(/^sha512-/);
  expect(prunePlan(target).directories).toContain("@koromix/koffi-linux-arm64/musl_arm64");
});

it("stage_pins_node_sha", async () => {
  for (const pin of Object.values(NODE_RUNTIME_PINS)) expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/);
  const base = await privateBase();
  const archive = await nodeTarball(base);
  await expect(
    extractNodeRuntime({ archive, target, destination: join(base, "refused") }),
  ).rejects.toThrow("does not match its pinned SHA-256");
  const pin = { name: NODE_RUNTIME_PINS[target].name, sha256: await sha256File(archive) };
  const runtime = await extractNodeRuntime({ archive, target, destination: join(base, "ok"), pin });
  expect(await readFile(runtime.license, "utf8")).toBe("Node license");
  await expect(
    extractNodeRuntime({
      archive,
      target: "x86_64-unknown-linux-gnu",
      destination: join(base, "wrong"),
      pin: { name: NODE_RUNTIME_PINS["x86_64-unknown-linux-gnu"].name, sha256: pin.sha256 },
    }),
  ).rejects.toThrow("extraction failed");
});

async function stageInputs(base: string) {
  const archive = await nodeTarball(base);
  const dist = await writeTree(join(base, "dist"), {
    "bin.mjs": "import './chunk.mjs'; export const later = () => import('node-pty');",
    "chunk.mjs":
      "import { createRequire } from 'node:module'; var __require = createRequire(import.meta.url); export const dep = __require('dep');",
    "chunk.mjs.map": "{}",
    "NodeSqliteWorker.mjs": "import 'node:sqlite';",
    "remote-client-relay/remoteBackendClientRelay.mjs": "import 'node:http';",
    "client/index.html": "<html></html>",
  });
  const nodeModules = await writeTree(join(base, "node_modules"), {
    "dep/package.json": JSON.stringify({ name: "dep", version: "1.0.0", license: "MIT" }),
    "dep/index.js": "module.exports = 1;",
    "dep/LICENSE": "MIT dep",
  });
  const license = join(base, "LICENSE");
  await writeTree(base, { LICENSE: "MIT bigbud" });
  const key = await signingKey(base);
  return {
    key,
    input: {
      target,
      version: "0.1.0-test",
      dist,
      nodeArchive: archive,
      nodePin: { name: NODE_RUNTIME_PINS[target].name, sha256: await sha256File(archive) },
      nodeModules,
      projectLicense: license,
      externals: { lockSha256: "f".repeat(64), skippedInstallScripts: [], pruned: 0 },
      keyFile: key.keyFile,
      keyId: "fixture",
    },
  };
}

it("stage_is_deterministic", async () => {
  const base = await privateBase();
  const { key, input } = await stageInputs(base);
  const first = await stageRemoteBackendGraph({ ...input, output: join(base, "one") });
  const second = await stageRemoteBackendGraph({ ...input, output: join(base, "two") });
  const read = (dir: string, name: string) => readFile(join(dir, name), "utf8");
  expect(await read(first.output, "manifest.json")).toBe(
    await read(second.output, "manifest.json"),
  );
  expect(first.provenance.archive).toEqual(second.provenance.archive);
  expect(first.provenance.buildDigest).toBe(second.provenance.buildDigest);
  expect(first.provenance.buildInputs.loaderPolicySha256).toMatch(/^[a-f0-9]{64}$/);
  expect(first.manifest.buildDigest).toBe(first.provenance.buildDigest);
  expect(first.provenance.closure?.absentOptional).toEqual([
    { from: "server/bin.mjs", specifier: "node-pty" },
  ]);
  expect(first.manifest.files.map((file) => file.path)).toEqual([
    "LICENSE",
    "NOTICES.json",
    "node_modules/dep/LICENSE",
    "node_modules/dep/index.js",
    "node_modules/dep/package.json",
    "runtime/LICENSE",
    "runtime/node",
    "server/NodeSqliteWorker.mjs",
    "server/bin.mjs",
    "server/chunk.mjs",
    "server/remote-client-relay/remoteBackendClientRelay.mjs",
  ]);
  await expect(
    verifyBackendGraph({
      root: first.graph,
      manifest: first.manifest,
      trustStore: { fixture: key.publicKey },
      target,
    }),
  ).resolves.toBeDefined();
  // Output directories are never reused.
  await expect(stageRemoteBackendGraph({ ...input, output: join(base, "one") })).rejects.toThrow();
});

it("notices_cover_every_package_dir", async () => {
  const graph = await writeTree(join(await privateBase(), "graph"), {
    "node_modules/a/package.json": JSON.stringify({ name: "a", version: "1.0.0", license: "MIT" }),
    "node_modules/a/LICENSE.md": "MIT a",
    "node_modules/a/dist/package.json": JSON.stringify({ type: "module" }),
    "node_modules/a/node_modules/c/package.json": JSON.stringify({ name: "c", version: "2.0.0" }),
    "node_modules/a/node_modules/c/NOTICE": "notice c",
    "node_modules/@s/b/package.json": JSON.stringify({
      name: "@s/b",
      version: "3.0.0",
      license: { type: "Apache-2.0" },
    }),
    "node_modules/@s/b/LICENSES/dep.txt": "transitive notice",
    "node_modules/d/package.json": JSON.stringify({ name: "d", version: "4.0.0", license: "ISC" }),
  });
  const entries = await collectPackageNotices(graph);
  expect(entries.map((entry) => entry.directory)).toEqual([
    "node_modules/@s/b",
    "node_modules/a",
    "node_modules/a/node_modules/c",
    "node_modules/d",
  ]);
  expect(
    entries.map((entry) => [entry.name, entry.license, entry.files.map((f) => f.path)]),
  ).toEqual([
    ["@s/b", "Apache-2.0", ["node_modules/@s/b/LICENSES/dep.txt"]],
    ["a", "MIT", ["node_modules/a/LICENSE.md"]],
    ["c", null, ["node_modules/a/node_modules/c/NOTICE"]],
    ["d", "ISC", []],
  ]);
  expect(
    bundledPackagesFromRegions([
      "//#region ../../node_modules/.bun/@scope+x@1.0.0/node_modules/@scope/x/index.js\n//#endregion\n" +
        "//#region src/own.ts\n//#endregion",
    ]),
  ).toEqual([
    { name: "@scope/x", storePath: "node_modules/.bun/@scope+x@1.0.0/node_modules/@scope/x" },
  ]);
});
