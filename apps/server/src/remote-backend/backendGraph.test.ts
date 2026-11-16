import { generateKeyPairSync, createHash, sign } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  canonicalBackendGraphPayload,
  decodeBackendGraphManifest,
} from "./backendGraph.manifest.ts";
import {
  verifyBackendGraph,
  revalidateBackendGraph,
  type VerifiedBackendGraph,
} from "./backendGraph.ts";

const mutation = vi.hoisted(() => ({
  afterOpen: undefined as ((path: string) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args);
      try {
        await mutation.afterOpen?.(String(args[0]));
        return file;
      } catch (error) {
        await file.close();
        throw error;
      }
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  mutation.afterOpen = undefined;
  for (const path of roots.splice(0)) await fs.rm(path, { recursive: true, force: true });
});
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const parent = await fs.realpath(await fs.mkdtemp("/tmp/be-graph-"));
  roots.push(parent);
  const root = join(parent, "graph");
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(join(root, "chunks"), { mode: 0o700 });
  const content = [
    ["node", "fixture node", true],
    ["entry.mjs", "import './chunks/sqlite-worker.mjs'", false],
    ["chunks/sqlite-worker.mjs", "fixture worker", false],
  ] as const;
  for (const [path, body, executable] of content)
    await fs.writeFile(join(root, path), body, { mode: executable ? 0o700 : 0o600 });
  const keys = generateKeyPairSync("ed25519");
  const manifest = decodeBackendGraphManifest({
    revision: 1,
    version: "1.0.0-test",
    buildDigest: "a".repeat(64),
    target: "aarch64-unknown-linux-gnu",
    node: "node",
    entry: "entry.mjs",
    files: content.map(([path, body, executable]) => ({
      path,
      executable,
      sizeBytes: Buffer.byteLength(body),
      sha256: sha(body),
    })),
    signature: { algorithm: "ed25519", keyId: "test", value: "A".repeat(88) },
  });
  const signed = {
    ...manifest,
    signature: {
      ...manifest.signature,
      value: sign(null, canonicalBackendGraphPayload(manifest), keys.privateKey).toString("base64"),
    },
  };
  const input = {
    root,
    manifest: signed,
    trustStore: { test: keys.publicKey.export({ type: "spki", format: "pem" }).toString() },
    target: "aarch64-unknown-linux-gnu" as const,
  };
  return { root, parent, input, signed };
}
it("authenticates every declared member and returns only a real in-process provenance token", async () => {
  const { root, input } = await fixture();
  const token = await verifyBackendGraph(input);
  const snapshot = await revalidateBackendGraph(token);
  expect(snapshot.nodePath).toBe(join(root, "node"));
  expect(snapshot.entryPath).toBe(join(root, "entry.mjs"));
  expect(snapshot.nodeSha256).toBe(sha("fixture node"));
  expect(snapshot.entrySha256).toBe(sha("import './chunks/sqlite-worker.mjs'"));
  expect(snapshot.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(token)).toEqual([]);
  await expect(revalidateBackendGraph({ ...token } as VerifiedBackendGraph)).rejects.toThrow(
    "original verified token",
  );
});
it("rejects untrusted, altered and wrong-target manifests before reading the root", async () => {
  const { input, signed } = await fixture();
  const root = "/does-not-exist-untrusted-graph";
  await expect(verifyBackendGraph({ ...input, root, trustStore: {} })).rejects.toThrow(
    "signature or target",
  );
  await expect(
    verifyBackendGraph({ ...input, root, manifest: { ...signed, version: "changed" } }),
  ).rejects.toThrow("signature or target");
  await expect(
    verifyBackendGraph({ ...input, root, target: "x86_64-unknown-linux-gnu" }),
  ).rejects.toThrow("signature or target");
});
it.each(["extra", "missing", "changed", "hardlink", "symlink", "mode"])(
  "refuses %s graph membership or bytes",
  async (kind) => {
    const { root, input } = await fixture();
    const worker = join(root, "chunks/sqlite-worker.mjs");
    if (kind === "extra") await fs.writeFile(join(root, "extra.js"), "extra", { mode: 0o600 });
    if (kind === "missing") await fs.unlink(worker);
    if (kind === "changed") await fs.writeFile(worker, "mutated worker");
    if (kind === "hardlink") await fs.link(worker, join(root, "linked"));
    if (kind === "symlink") {
      await fs.unlink(worker);
      await fs.symlink("../entry.mjs", worker);
    }
    if (kind === "mode") await fs.chmod(worker, 0o644);
    await expect(verifyBackendGraph(input)).rejects.toThrow();
  },
);
it("revalidates worker bytes and refuses a root replaced after admission", async () => {
  const { root, input } = await fixture();
  const token = await verifyBackendGraph(input);
  await fs.writeFile(join(root, "chunks/sqlite-worker.mjs"), "mutated worker");
  await expect(revalidateBackendGraph(token)).rejects.toThrow();
  await fs.writeFile(join(root, "chunks/sqlite-worker.mjs"), "fixture worker");
  const moved = `${root}-old`;
  await fs.rename(root, moved);
  await fs.cp(moved, root, { recursive: true });
  await expect(revalidateBackendGraph(token)).rejects.toThrow("root was replaced");
});
it("strictly rejects traversal, duplicate/unknown metadata and noncanonical signature text", async () => {
  const { input, signed } = await fixture();
  expect(() => decodeBackendGraphManifest({ ...signed, unknown: true })).toThrow("unknown fields");
  expect(() =>
    decodeBackendGraphManifest({ ...signed, files: [...signed.files, signed.files[0]] }),
  ).toThrow("member");
  expect(() => decodeBackendGraphManifest({ ...signed, node: "../node" })).toThrow("metadata");
  await expect(
    verifyBackendGraph({
      ...input,
      manifest: {
        ...signed,
        signature: { ...signed.signature, value: `${signed.signature.value.slice(0, -1)}\n` },
      },
    }),
  ).rejects.toThrow("signature or target");
});

it("cancels staged verification and later revalidation without touching graph bytes", async () => {
  const { root, input } = await fixture();
  const token = await verifyBackendGraph(input);
  const original = await fs.readFile(join(root, "node"));
  const controller = new AbortController();
  controller.abort(new Error("staged install canceled"));
  await expect(verifyBackendGraph({ ...input, signal: controller.signal })).rejects.toThrow(
    "staged install canceled",
  );
  await expect(revalidateBackendGraph(token, controller.signal)).rejects.toThrow(
    "staged install canceled",
  );
  expect(await fs.readFile(join(root, "node"))).toEqual(original);
});

it("refuses an earlier hashed member overwritten while a later member is verified", async () => {
  const { input } = await fixture();
  let first: string | undefined;
  let changed = false;
  mutation.afterOpen = async (path) => {
    if (!first) {
      first = path;
      return;
    }
    if (!changed) {
      changed = true;
      const bytes = await fs.readFile(first);
      await fs.writeFile(first, Buffer.alloc(bytes.length, 120));
    }
  };
  await expect(verifyBackendGraph(input)).rejects.toThrow("member changed during verification");
  expect(changed).toBe(true);
});
