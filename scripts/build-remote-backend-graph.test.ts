import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ afterClosure: undefined as undefined | (() => Promise<void>) }));
vi.mock("./build-remote-backend-graph.closure.ts", async (original) => {
  const actual = await original<typeof import("./build-remote-backend-graph.closure.ts")>();
  return {
    validateBackendGraphClosure: async (
      ...args: Parameters<typeof actual.validateBackendGraphClosure>
    ) => {
      await actual.validateBackendGraphClosure(...args);
      await state.afterClosure?.();
    },
  };
});
import { generateKeyPairSync } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRemoteBackendGraph } from "./build-remote-backend-graph.producer.ts";
import { verifyBackendGraph } from "../apps/server/src/remote-backend/backendGraph.ts";
const roots: string[] = [];
afterEach(async () => {
  state.afterClosure = undefined;
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "bb-graph-producer-")));
  roots.push(base);
  await chmod(base, 0o700);
  const root = join(base, "graph");
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, "remote-client-relay"), { mode: 0o700 });
  await mkdir(join(root, "remote-peer-relay"), { mode: 0o700 });
  const node = Buffer.alloc(64);
  node.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  node.writeUInt16LE(2, 16);
  node.writeUInt16LE(183, 18);
  await writeFile(join(root, "node"), node, { mode: 0o700 });
  for (const [name, body] of [
    ["bin.mjs", "import './chunk.mjs';"],
    ["chunk.mjs", "export const ready=true;"],
    ["NodeSqliteWorker.mjs", "import 'node:sqlite';"],
    ["remote-client-relay/remoteBackendClientRelay.mjs", "import 'node:http';"],
    ["remote-peer-relay/remoteBackendPeerRelay.mjs", "import 'node:http';"],
  ])
    await writeFile(join(root, name!), body!, { mode: 0o600 });
  const keys = generateKeyPairSync("ed25519"),
    keyFile = join(base, "key.pem");
  await writeFile(keyFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), {
    mode: 0o600,
  });
  const input = {
    root,
    version: "1.0.0",
    buildDigest: "a".repeat(64),
    target: "aarch64-unknown-linux-gnu" as const,
    node: "node",
    entry: "bin.mjs",
    keyFile,
    keyId: "fixture",
    output: join(base, "manifest.json"),
  };
  return {
    base,
    root,
    input,
    publicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
it("signs a complete private static fixture accepted by the real opaque verifier", async () => {
  const f = await fixture(),
    manifest = await buildRemoteBackendGraph(f.input);
  await expect(
    verifyBackendGraph({
      root: f.root,
      manifest,
      trustStore: { fixture: f.publicKey },
      target: f.input.target,
    }),
  ).resolves.toBeDefined();
  expect(JSON.parse(await readFile(f.input.output, "utf8"))).toEqual(manifest);
  expect(manifest.files.map((x) => x.path)).toContain(
    "remote-client-relay/remoteBackendClientRelay.mjs",
  );
  await expect(buildRemoteBackendGraph(f.input)).rejects.toThrow();
});
it.each([
  "architecture",
  "basename",
  "digest",
  "worker",
  "external",
  "dynamic",
  "link",
  "key-containment",
  "permissions",
  "key-copy",
])("refuses %s", async (kind) => {
  const f = await fixture();
  if (kind === "architecture") f.input.target = "x86_64-unknown-linux-gnu" as typeof f.input.target;
  if (kind === "basename") f.input.node = "renamed-node";
  if (kind === "digest") f.input.buildDigest = "not-a-digest";
  if (kind === "worker") await rm(join(f.root, "NodeSqliteWorker.mjs"));
  if (kind === "external")
    await writeFile(join(f.root, "chunk.mjs"), "import 'missing-private-package';");
  if (kind === "dynamic")
    await writeFile(join(f.root, "chunk.mjs"), "export const load=(name)=>import(name);");
  if (kind === "link") await symlink("chunk.mjs", join(f.root, "link.mjs"));
  if (kind === "key-containment") {
    f.input.keyFile = join(f.root, "key.pem");
    await writeFile(f.input.keyFile, await readFile(join(f.base, "key.pem")), { mode: 0o600 });
  }
  if (kind === "key-copy")
    await writeFile(join(f.root, "copied.pem"), await readFile(f.input.keyFile), { mode: 0o600 });
  if (kind === "permissions") await chmod(join(f.root, "chunk.mjs"), 0o644);
  await expect(buildRemoteBackendGraph(f.input)).rejects.toThrow();
  await expect(readFile(f.input.output)).rejects.toThrow();
});
it("a signed graph refuses content mutation at later verification", async () => {
  const f = await fixture(),
    manifest = await buildRemoteBackendGraph(f.input);
  await writeFile(join(f.root, "chunk.mjs"), "export const changed=true;");
  await expect(
    verifyBackendGraph({
      root: f.root,
      manifest,
      trustStore: { fixture: f.publicKey },
      target: f.input.target,
    }),
  ).rejects.toThrow();
});
it("refuses an insecure signing key without publishing", async () => {
  const f = await fixture();
  await chmod(f.input.keyFile, 0o644);
  await expect(buildRemoteBackendGraph(f.input)).rejects.toThrow("Signing key");
});

it("refuses an input changed after inventory before manifest publication", async () => {
  const f = await fixture();
  state.afterClosure = async () => {
    await writeFile(join(f.root, "chunk.mjs"), "export const changed = true;");
  };
  await expect(buildRemoteBackendGraph(f.input)).rejects.toThrow();
  await expect(readFile(f.input.output)).rejects.toThrow();
});

it.each(["..manifest.json", "..key.pem"])(
  "rejects graph-contained special child %s",
  async (name) => {
    const f = await fixture();
    if (name.includes("manifest")) f.input.output = join(f.root, name);
    else {
      f.input.keyFile = join(f.root, name);
      await writeFile(f.input.keyFile, await readFile(join(f.base, "key.pem")), { mode: 0o600 });
    }
    await expect(buildRemoteBackendGraph(f.input)).rejects.toThrow("separate");
  },
);
it.each([
  "export const broken = ;",
  "process.dlopen(module,'./native.node')",
  "module._load('./native.node')",
  "const loader=process.dlopen; loader(module,'./native.node')",
  "import { createRequire as c } from 'node:module'; const r=c(import.meta.url); r('./native.node')",
])("refuses unsupported syntax or loader %#", async (body) => {
  const f = await fixture();
  await writeFile(join(f.root, "chunk.mjs"), body);
  await expect(buildRemoteBackendGraph(f.input)).rejects.toThrow();
  await expect(readFile(f.input.output)).rejects.toThrow();
});
