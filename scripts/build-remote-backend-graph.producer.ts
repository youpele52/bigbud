import { createPublicKey, sign } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  verifyBackendGraph,
  revalidateBackendGraph,
} from "../apps/server/src/remote-backend/backendGraph.ts";
import {
  canonicalBackendGraphPayload,
  decodeBackendGraphManifest,
  isBackendGraphPath,
  type BackendGraphManifest,
} from "../apps/server/src/remote-backend/backendGraph.manifest.ts";
import { canonicalInput, fingerprint, readSigningKey } from "./lib/artifact-build/io.ts";
import { inventoryBackendGraph } from "./build-remote-backend-graph.inventory.ts";
import {
  validateBackendGraphClosure,
  type BackendGraphClosureReport,
} from "./build-remote-backend-graph.closure.ts";
import type { BackendGraphLoaderPolicy } from "./build-remote-backend-graph.policy.ts";

export interface BuildBackendGraphInput {
  readonly root: string;
  readonly version: string;
  readonly buildDigest: string;
  readonly target: "aarch64-unknown-linux-gnu" | "x86_64-unknown-linux-gnu";
  readonly node: string;
  readonly entry: string;
  readonly keyFile: string;
  readonly keyId: string;
  readonly output: string;
  readonly signal?: AbortSignal;
  /** Defaults to the checked-in policy; its digest belongs in the caller's build provenance. */
  readonly loaderPolicy?: BackendGraphLoaderPolicy;
  readonly onClosureReport?: (report: BackendGraphClosureReport) => void;
}
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
};
async function validateNode(path: string, target: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bytes = Buffer.alloc(20);
    if (
      (await file.read(bytes, 0, 20, 0)).bytesRead !== 20 ||
      bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
      bytes[4] !== 2 ||
      bytes[5] !== 1 ||
      ![2, 3].includes(bytes.readUInt16LE(16)) ||
      bytes.readUInt16LE(18) !== (target.startsWith("aarch64") ? 183 : 62)
    )
      throw new Error("Private Node must be a matching Linux ELF64 executable.");
  } finally {
    await file.close();
  }
}
/** Helper entries started beside the backend entry; they are closure roots too. */
export const backendGraphRequiredRoots = (entry: string) => [
  join(dirname(entry), "NodeSqliteWorker.mjs"),
  join(dirname(entry), "remote-client-relay/remoteBackendClientRelay.mjs"),
];
/** Build/sign only. The caller's signing key is explicit; this does not establish release trust. */
export async function buildRemoteBackendGraph(
  input: BuildBackendGraphInput,
): Promise<BackendGraphManifest> {
  input.signal?.throwIfAborted();
  if (
    !["aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"].includes(input.target) ||
    !isBackendGraphPath(input.node) ||
    basename(input.node) !== "node" ||
    !isBackendGraphPath(input.entry)
  )
    throw new Error("Unsupported backend graph target or entry paths.");
  const root = await canonicalInput(input.root),
    keyFile = await canonicalInput(input.keyFile),
    output = resolve(input.output);
  const parent = dirname(output),
    parentInfo = await lstat(parent);
  if (
    (await realpath(parent)) !== parent ||
    !parentInfo.isDirectory() ||
    parentInfo.uid !== process.getuid?.() ||
    (parentInfo.mode & 0o777) !== 0o700 ||
    inside(root, keyFile) ||
    inside(root, output) ||
    inside(keyFile, output)
  )
    throw new Error(
      "Signing key/output must be separate from the graph and output parent private.",
    );
  const keyIdentity = fingerprint(await lstat(keyFile));
  const key = await readSigningKey(keyFile);
  const publicKey = createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
  const files = await inventoryBackendGraph(root, input.signal);
  const required = backendGraphRequiredRoots(input.entry);
  if (required.some((path) => !files.some((file) => file.path === path)))
    throw new Error(
      "Backend graph must include its SQLite worker and standalone client relay helper.",
    );
  await validateNode(join(root, input.node), input.target);
  const report = await validateBackendGraphClosure(root, files, {
    entry: input.entry,
    target: input.target,
    roots: required,
    ...(input.loaderPolicy ? { policy: input.loaderPolicy } : {}),
  });
  input.onClosureReport?.(report);
  const unsigned: BackendGraphManifest = {
    revision: 1,
    version: input.version,
    buildDigest: input.buildDigest,
    target: input.target,
    node: input.node,
    entry: input.entry,
    files,
    signature: { algorithm: "ed25519", keyId: input.keyId, value: "A".repeat(88) },
  };
  // Decode before signing so sorted membership and every metadata invariant match the verifier.
  const canonical = decodeBackendGraphManifest(unsigned);
  const manifest = decodeBackendGraphManifest({
    ...canonical,
    signature: {
      ...canonical.signature,
      value: sign(null, canonicalBackendGraphPayload(canonical), key).toString("base64"),
    },
  });
  const token = await verifyBackendGraph({
    root,
    manifest,
    trustStore: { [input.keyId]: publicKey },
    target: input.target,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const finalKey = await readSigningKey(keyFile);
  if (
    fingerprint(await lstat(keyFile)) !== keyIdentity ||
    createPublicKey(finalKey).export({ format: "pem", type: "spki" }).toString() !== publicKey
  )
    throw new Error("Signing key changed during graph production.");
  await revalidateBackendGraph(token, input.signal);
  if (fingerprint(await lstat(parent)) !== fingerprint(parentInfo))
    throw new Error("Manifest output directory changed.");
  const file = await open(
    output,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify(manifest, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(parent, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return manifest;
}
