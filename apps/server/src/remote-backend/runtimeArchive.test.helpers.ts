import { createHash, generateKeyPairSync, sign } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  canonicalBackendGraphPayload,
  decodeBackendGraphManifest,
} from "./backendGraph.manifest.ts";
import { verifyBackendGraph } from "./backendGraph.ts";
import { runtimeArchiveKeyForManifest, type RuntimeArchiveKey } from "./runtimeArchive.key.ts";
import {
  openRuntimeArchiveStore,
  recordRuntimeArchive,
  reserveRuntimeArchive,
  type RuntimeArchiveStore,
} from "./runtimeArchive.store.ts";

const TARGET = "aarch64-unknown-linux-gnu" as const;
const keys = generateKeyPairSync("ed25519");
export const trustStore = Object.freeze({
  fixture: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
});
const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const members = (version: string) =>
  [
    ["node", `fixture node ${version}`, true],
    ["entry.mjs", "import './chunks/worker.mjs';", false],
    ["chunks/worker.mjs", `export const version = ${JSON.stringify(version)};`, false],
  ] as const;

export function signedManifest(version: string) {
  const draft = decodeBackendGraphManifest({
    revision: 1,
    version,
    buildDigest: sha(version),
    target: TARGET,
    node: "node",
    entry: "entry.mjs",
    files: members(version).map(([path, body, executable]) => ({
      path,
      executable,
      sizeBytes: Buffer.byteLength(body),
      sha256: sha(body),
    })),
    signature: { algorithm: "ed25519", keyId: "fixture", value: "A".repeat(88) },
  });
  const value = sign(null, canonicalBackendGraphPayload(draft), keys.privateKey);
  return { ...draft, signature: { ...draft.signature, value: value.toString("base64") } };
}

/** Writes the graph members as an extraction would (private modes, no links). */
export async function writeGraph(root: string, version: string) {
  await fs.mkdir(join(root, "chunks"), { recursive: true, mode: 0o700 });
  for (const [path, body, executable] of members(version))
    await fs.writeFile(join(root, path), body, { mode: executable ? 0o700 : 0o600 });
}

export async function verifyGraphAt(root: string, version: string) {
  return verifyBackendGraph({
    root,
    manifest: signedManifest(version),
    trustStore,
    target: TARGET,
  });
}

/** Reserve → extract → verify → record, the order the update operation follows. */
export async function stageRuntimeArchive(
  store: RuntimeArchiveStore,
  version: string,
): Promise<RuntimeArchiveKey> {
  const key = runtimeArchiveKeyForManifest(signedManifest(version));
  const slot = await reserveRuntimeArchive(store, key);
  await writeGraph(slot.graphRoot, version);
  await recordRuntimeArchive(store, await verifyGraphAt(slot.graphRoot, version));
  return key;
}

export interface RuntimeArchiveFixture {
  readonly parent: string;
  readonly root: string;
  readonly backendHome: string;
  readonly open: (checkpoint?: () => Promise<void>) => Promise<RuntimeArchiveStore>;
}
export async function makeRuntimeArchiveFixture(
  cleanup: Array<string>,
): Promise<RuntimeArchiveFixture> {
  const parent = await fs.realpath(await fs.mkdtemp("/tmp/bb-runtime-archive-"));
  cleanup.push(parent);
  const root = join(parent, "backend-runtimes", "authority");
  const backendHome = join(parent, "backend-home");
  await fs.mkdir(backendHome, { mode: 0o700 });
  return {
    parent,
    root,
    backendHome,
    open: (checkpoint) =>
      openRuntimeArchiveStore({
        root,
        mutableRoots: [backendHome, join(backendHome, "userdata")],
        ...(checkpoint ? { checkpoint } : {}),
      }),
  };
}

export async function presentKeys(store: RuntimeArchiveStore) {
  return (await fs.readdir(store.entries)).toSorted();
}
