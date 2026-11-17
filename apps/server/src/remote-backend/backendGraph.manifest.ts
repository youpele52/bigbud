import { createHash } from "node:crypto";
import { verifyPinnedArtifactSignature } from "@bigbud/shared/artifactSignature";
import {
  isRemoteAgentTargetTriple,
  type RemoteAgentTargetTriple,
} from "@bigbud/shared/remoteAgentArtifact";

export interface BackendGraphFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly executable: boolean;
}
export interface BackendGraphManifest {
  readonly revision: 1;
  readonly version: string;
  readonly buildDigest: string;
  readonly target: RemoteAgentTargetTriple;
  readonly node: string;
  readonly entry: string;
  readonly files: ReadonlyArray<BackendGraphFile>;
  readonly signature: {
    readonly algorithm: "ed25519";
    readonly keyId: string;
    readonly value: string;
  };
}
export const BACKEND_GRAPH_MAX_FILES = 16384;
export const BACKEND_GRAPH_MAX_BYTES = 2 * 1024 ** 3;
const digest = /^[a-f0-9]{64}$/;
function object(value: unknown, keys: ReadonlyArray<string>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid executable graph object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key)))
    throw new Error("Executable graph contains missing or unknown fields.");
  return record;
}
export function isBackendGraphPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    /^[A-Za-z0-9@_.+/-]+$/.test(value) &&
    value.split("/").length <= 32 &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
export function decodeBackendGraphManifest(value: unknown): BackendGraphManifest {
  const m = object(value, [
    "revision",
    "version",
    "buildDigest",
    "target",
    "node",
    "entry",
    "files",
    "signature",
  ]);
  if (
    m.revision !== 1 ||
    typeof m.version !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(m.version) ||
    typeof m.buildDigest !== "string" ||
    !digest.test(m.buildDigest) ||
    !isRemoteAgentTargetTriple(m.target) ||
    !isBackendGraphPath(m.node) ||
    !isBackendGraphPath(m.entry) ||
    m.node === m.entry ||
    !Array.isArray(m.files) ||
    m.files.length < 2 ||
    m.files.length > BACKEND_GRAPH_MAX_FILES
  )
    throw new Error("Executable graph metadata is unsupported or oversized.");
  const seen = new Set<string>();
  let bytes = 0;
  const files = m.files
    .map((value): BackendGraphFile => {
      const f = object(value, ["path", "sizeBytes", "sha256", "executable"]);
      if (
        !isBackendGraphPath(f.path) ||
        seen.has(f.path) ||
        typeof f.sizeBytes !== "number" ||
        !Number.isSafeInteger(f.sizeBytes) ||
        f.sizeBytes < 0 ||
        typeof f.sha256 !== "string" ||
        !digest.test(f.sha256) ||
        typeof f.executable !== "boolean"
      )
        throw new Error("Invalid executable graph member.");
      seen.add(f.path);
      bytes += f.sizeBytes;
      if (bytes > BACKEND_GRAPH_MAX_BYTES)
        throw new Error("Executable graph exceeds its byte budget.");
      return Object.freeze({
        path: f.path,
        sizeBytes: f.sizeBytes,
        sha256: f.sha256,
        executable: f.executable,
      });
    })
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const node = files.find((f) => f.path === m.node);
  const entry = files.find((f) => f.path === m.entry);
  if (!node?.executable || !entry || node.sizeBytes === 0 || entry.sizeBytes === 0)
    throw new Error("Executable graph must include its Node executable and backend entry.");
  const signature = object(m.signature, ["algorithm", "keyId", "value"]);
  if (
    signature.algorithm !== "ed25519" ||
    typeof signature.keyId !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(signature.keyId) ||
    typeof signature.value !== "string" ||
    signature.value.length !== 88
  )
    throw new Error("Invalid executable graph signature metadata.");
  return Object.freeze({
    revision: 1,
    version: m.version,
    buildDigest: m.buildDigest,
    target: m.target,
    node: m.node,
    entry: m.entry,
    files: Object.freeze(files),
    signature: Object.freeze({
      algorithm: "ed25519",
      keyId: signature.keyId,
      value: signature.value,
    }),
  });
}
export function canonicalBackendGraphPayload(manifest: BackendGraphManifest): Buffer {
  const { revision, version, buildDigest, target, node, entry, files } = manifest;
  return Buffer.from(
    `bigbud.remote-backend.executable-graph.v1\0${JSON.stringify({ revision, version, buildDigest, target, node, entry, files })}`,
  );
}
/** The digest verification pins as `manifestDigest` (signature excluded). */
export function backendGraphManifestDigest(manifest: BackendGraphManifest): string {
  return createHash("sha256").update(canonicalBackendGraphPayload(manifest)).digest("hex");
}
export function authenticateBackendGraphManifest(
  value: unknown,
  trustStore: Readonly<Record<string, string>>,
  target: RemoteAgentTargetTriple,
) {
  const manifest = decodeBackendGraphManifest(value);
  const publicKey = Object.hasOwn(trustStore, manifest.signature.keyId)
    ? trustStore[manifest.signature.keyId]
    : undefined;
  if (
    manifest.target !== target ||
    !publicKey ||
    !verifyPinnedArtifactSignature({
      payload: canonicalBackendGraphPayload(manifest),
      publicKey,
      signature: manifest.signature.value,
      strictEd25519: true,
    })
  )
    throw new Error("Executable graph signature or target verification failed.");
  return manifest;
}
