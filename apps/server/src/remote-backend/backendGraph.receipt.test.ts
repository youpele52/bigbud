import { afterEach, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalBackendGraphPayload,
  decodeBackendGraphManifest,
} from "./backendGraph.manifest.ts";
import { verifyBackendGraph, type VerifiedBackendGraph } from "./backendGraph.ts";
import {
  serializeVerifiedBackendGraphReceipt,
  withVerifiedBackendGraphReceipt,
} from "./backendGraph.receipt.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
async function fixture(name = "graph") {
  const parent = await fs.realpath(await fs.mkdtemp("/tmp/bb-graph-receipt-"));
  roots.push(parent);
  const root = join(parent, name);
  await fs.mkdir(root, { mode: 0o700 });
  const contents = [
    ["node", "fixture node", true],
    ["entry.mjs", "import './chunk.mjs';", false],
    ["chunk.mjs", "export const value=1;", false],
  ] as const;
  for (const [path, body, executable] of contents)
    await fs.writeFile(join(root, path), body, { mode: executable ? 0o700 : 0o600 });
  const keys = generateKeyPairSync("ed25519");
  const draft = decodeBackendGraphManifest({
    revision: 1,
    version: "1-fixture",
    buildDigest: "a".repeat(64),
    target: "aarch64-unknown-linux-gnu",
    node: "node",
    entry: "entry.mjs",
    files: contents.map(([path, body, executable]) => ({
      path,
      executable,
      sizeBytes: Buffer.byteLength(body),
      sha256: sha(body),
    })),
    signature: { algorithm: "ed25519", keyId: "fixture", value: "A".repeat(88) },
  });
  const manifest = decodeBackendGraphManifest({
    ...draft,
    signature: {
      ...draft.signature,
      value: sign(null, canonicalBackendGraphPayload(draft), keys.privateKey).toString("base64"),
    },
  });
  const token = await verifyBackendGraph({
    root,
    manifest,
    target: manifest.target,
    trustStore: { fixture: keys.publicKey.export({ type: "spki", format: "pem" }).toString() },
  });
  return { root, token, manifest };
}
it("serializes the actual revalidated member pins and root identity in native order", async () => {
  const f = await fixture(),
    receipt = await serializeVerifiedBackendGraphReceipt(f.token);
  const root = await fs.stat(f.root, { bigint: true });
  expect(receipt.raw).toBe(
    [
      "bigbud-backend-graph-receipt=1",
      `root=${f.root}`,
      `root_dev=${root.dev}`,
      `root_ino=${root.ino}`,
      `root_ctime_ns=${root.ctimeNs}`,
      `manifest_sha256=${createHash("sha256").update(canonicalBackendGraphPayload(f.manifest)).digest("hex")}`,
      "node=node",
      "entry=entry.mjs",
      ...f.manifest.files.map(
        (file) =>
          `file=${file.sha256}\t${file.sizeBytes}\t${file.executable ? "700" : "600"}\t${file.path}`,
      ),
      "",
    ].join("\n"),
  );
  expect(receipt.sha256).toBe(sha(receipt.raw));
  expect(receipt.nodePath).toBe(join(f.root, "node"));
  expect(Object.isFrozen(receipt)).toBe(true);
});
it("rejects cloned proof or serialized data as a later approval", async () => {
  const f = await fixture(),
    receipt = await serializeVerifiedBackendGraphReceipt(f.token);
  for (const fake of [{ ...f.token }, receipt])
    await expect(
      serializeVerifiedBackendGraphReceipt(fake as VerifiedBackendGraph),
    ).rejects.toThrow("original verified token");
});
it("revalidates before serialization and before every actual side-effect callback", async () => {
  const f = await fixture();
  await serializeVerifiedBackendGraphReceipt(f.token);
  await fs.writeFile(join(f.root, "chunk.mjs"), "changed after earlier serialization");
  let writes = 0;
  await expect(
    withVerifiedBackendGraphReceipt(f.token, async () => {
      writes++;
    }),
  ).rejects.toThrow();
  expect(writes).toBe(0);
  await expect(serializeVerifiedBackendGraphReceipt(f.token)).rejects.toThrow();
});
it("uses only current proof at the callback boundary and refuses an aborted operation", async () => {
  const f = await fixture();
  let calls = 0;
  const value = await withVerifiedBackendGraphReceipt(f.token, async (receipt) => {
    calls++;
    return receipt.sha256;
  });
  expect(value).toHaveLength(64);
  expect(calls).toBe(1);
  const controller = new AbortController();
  controller.abort();
  await expect(
    withVerifiedBackendGraphReceipt(
      f.token,
      async () => {
        calls++;
      },
      controller.signal,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(1);
});

it.each(["graph\nnode=forged", "graph\u0085"])(
  "refuses control characters in a native receipt root %#",
  async (name) => {
    const f = await fixture(name);
    await expect(serializeVerifiedBackendGraphReceipt(f.token)).rejects.toThrow("unambiguous root");
  },
);
