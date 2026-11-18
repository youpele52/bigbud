import { createHash } from "node:crypto";
import { verifyPinnedArtifactSignature } from "./artifactSignature.ts";

export const REMOTE_AGENT_SUPPORTED_PROTOCOL_MAJOR = 1;

/**
 * Recognised Linux targets. Static musl builds run on any supported distribution; glibc builds
 * stay recognised for historic manifests, pinned releases and installed-build cleanup (D4).
 */
export const REMOTE_AGENT_TARGET_TRIPLES = [
  "x86_64-unknown-linux-musl",
  "aarch64-unknown-linux-musl",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
] as const;

export type RemoteAgentTargetTriple = (typeof REMOTE_AGENT_TARGET_TRIPLES)[number];
export type RemoteAgentTargetArchitecture = "x86_64" | "aarch64";
export type RemoteAgentHostLibc = "glibc" | "musl" | "unknown";

export function isRemoteAgentTargetTriple(value: unknown): value is RemoteAgentTargetTriple {
  return (REMOTE_AGENT_TARGET_TRIPLES as ReadonlyArray<unknown>).includes(value);
}

export function remoteAgentTargetArchitecture(
  targetTriple: RemoteAgentTargetTriple,
): RemoteAgentTargetArchitecture {
  return targetTriple.startsWith("aarch64-") ? "aarch64" : "x86_64";
}

export function isRemoteAgentMuslTarget(targetTriple: RemoteAgentTargetTriple): boolean {
  return targetTriple.endsWith("-musl");
}

export interface RemoteAgentArtifactSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface RemoteAgentArtifact {
  readonly version: string;
  readonly buildDigest: string;
  readonly protocolMajor: number;
  readonly protocolMinor: number;
  readonly targetTriple: RemoteAgentTargetTriple;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly signature: RemoteAgentArtifactSignature;
  readonly bundledPath?: string;
  readonly url?: string;
}

export interface RemoteAgentArtifactManifest {
  readonly schemaVersion: 1;
  readonly artifacts: ReadonlyArray<RemoteAgentArtifact>;
}

export type RemoteAgentArtifactTrustStore = Readonly<Record<string, string>>;

export class RemoteAgentArtifactError extends Error {
  readonly _tag = "RemoteAgentArtifactError";

  constructor(message: string) {
    super(message);
    this.name = "RemoteAgentArtifactError";
  }
}

/** Host baseline triple (glibc form); use {@link remoteAgentTargetCandidates} to select. */
export function resolveRemoteAgentTargetTriple(
  operatingSystem: string,
  architecture: string,
): RemoteAgentTargetTriple | null {
  if (operatingSystem !== "linux") return null;
  if (architecture === "x86_64" || architecture === "amd64") {
    return "x86_64-unknown-linux-gnu";
  }
  if (architecture === "aarch64" || architecture === "arm64") {
    return "aarch64-unknown-linux-gnu";
  }
  return null;
}

/**
 * Ordered artifact preference for a host: the static musl build first, then the glibc build
 * unless the host is known to use musl (a glibc build cannot run there).
 */
export function remoteAgentTargetCandidates(
  hostTriple: RemoteAgentTargetTriple,
  hostLibc: RemoteAgentHostLibc = "unknown",
): ReadonlyArray<RemoteAgentTargetTriple> {
  const architecture = remoteAgentTargetArchitecture(hostTriple);
  const musl: RemoteAgentTargetTriple = `${architecture}-unknown-linux-musl`;
  const gnu: RemoteAgentTargetTriple = `${architecture}-unknown-linux-gnu`;
  return hostLibc === "musl" ? [musl] : [musl, gnu];
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RemoteAgentArtifactError(`${label} must be a non-empty string.`);
  }
}

function assertSafeVersion(version: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(version)) {
    throw new RemoteAgentArtifactError(`Invalid remote agent version '${version}'.`);
  }
}

function parseSignature(value: unknown): RemoteAgentArtifactSignature {
  if (typeof value !== "object" || value === null) {
    throw new RemoteAgentArtifactError("Artifact signature metadata is required.");
  }
  const signature = value as Record<string, unknown>;
  if (signature.algorithm !== "ed25519") {
    throw new RemoteAgentArtifactError("Artifact signature algorithm must be ed25519.");
  }
  assertString(signature.keyId, "Artifact signature keyId");
  assertString(signature.value, "Artifact signature value");
  return { algorithm: "ed25519", keyId: signature.keyId, value: signature.value };
}

function parseArtifact(value: unknown): RemoteAgentArtifact {
  if (typeof value !== "object" || value === null) {
    throw new RemoteAgentArtifactError("Each remote agent artifact must be an object.");
  }
  const artifact = value as Record<string, unknown>;
  assertString(artifact.version, "Artifact version");
  assertSafeVersion(artifact.version);
  assertString(artifact.buildDigest, "Artifact buildDigest");
  if (artifact.protocolMajor !== REMOTE_AGENT_SUPPORTED_PROTOCOL_MAJOR) {
    throw new RemoteAgentArtifactError(
      `Artifact protocol major ${String(artifact.protocolMajor)} is unsupported.`,
    );
  }
  if (typeof artifact.protocolMinor !== "number" || !Number.isInteger(artifact.protocolMinor)) {
    throw new RemoteAgentArtifactError("Artifact protocolMinor must be an integer.");
  }
  if (!isRemoteAgentTargetTriple(artifact.targetTriple)) {
    throw new RemoteAgentArtifactError("Artifact target triple is unsupported.");
  }
  if (
    typeof artifact.sizeBytes !== "number" ||
    !Number.isSafeInteger(artifact.sizeBytes) ||
    artifact.sizeBytes <= 0
  ) {
    throw new RemoteAgentArtifactError("Artifact sizeBytes must be a positive safe integer.");
  }
  assertString(artifact.sha256, "Artifact sha256");
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new RemoteAgentArtifactError("Artifact sha256 must be a lowercase SHA-256 digest.");
  }
  const signature = parseSignature(artifact.signature);
  const bundledPath = artifact.bundledPath;
  const url = artifact.url;
  if (bundledPath !== undefined) assertString(bundledPath, "Artifact bundledPath");
  if (url !== undefined) assertString(url, "Artifact url");
  if (bundledPath === undefined && url === undefined) {
    throw new RemoteAgentArtifactError("Artifact must provide a bundledPath or url.");
  }
  return {
    version: artifact.version,
    buildDigest: artifact.buildDigest,
    protocolMajor: artifact.protocolMajor,
    protocolMinor: artifact.protocolMinor,
    targetTriple: artifact.targetTriple,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    signature,
    ...(bundledPath !== undefined ? { bundledPath } : {}),
    ...(url !== undefined ? { url } : {}),
  };
}

export function parseRemoteAgentArtifactManifest(value: unknown): RemoteAgentArtifactManifest {
  if (typeof value !== "object" || value === null) {
    throw new RemoteAgentArtifactError("Remote agent artifact manifest must be an object.");
  }
  const manifest = value as Record<string, unknown>;
  if (manifest.schemaVersion !== 1) {
    throw new RemoteAgentArtifactError("Remote agent artifact manifest schema is unsupported.");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new RemoteAgentArtifactError("Remote agent artifact manifest has no artifacts.");
  }
  // Skip targets this client does not know so a later release can add triples without
  // breaking it; every retained artifact is still fully validated and signature-checked later.
  const artifacts = manifest.artifacts
    .filter(
      (artifact) =>
        typeof artifact !== "object" ||
        artifact === null ||
        isRemoteAgentTargetTriple((artifact as { targetTriple?: unknown }).targetTriple),
    )
    .map(parseArtifact);
  if (artifacts.length === 0) {
    throw new RemoteAgentArtifactError(
      "Remote agent artifact manifest has no artifacts for a supported target.",
    );
  }
  if (new Set(artifacts.map((artifact) => artifact.targetTriple)).size !== artifacts.length) {
    throw new RemoteAgentArtifactError("Remote agent artifact manifest has duplicate targets.");
  }
  return { schemaVersion: 1, artifacts };
}

/** Select the first compatible artifact in preference order (one triple or an ordered list). */
export function selectRemoteAgentArtifact(
  manifest: RemoteAgentArtifactManifest,
  targetTriples: RemoteAgentTargetTriple | ReadonlyArray<RemoteAgentTargetTriple>,
  protocolMajor = REMOTE_AGENT_SUPPORTED_PROTOCOL_MAJOR,
): RemoteAgentArtifact {
  const preference = typeof targetTriples === "string" ? [targetTriples] : targetTriples;
  for (const targetTriple of preference) {
    const artifact = manifest.artifacts.find(
      (candidate) =>
        candidate.targetTriple === targetTriple && candidate.protocolMajor === protocolMajor,
    );
    if (artifact) return artifact;
  }
  throw new RemoteAgentArtifactError(
    `No compatible remote agent artifact exists for ${preference.join(" or ")} and protocol ${protocolMajor}.`,
  );
}

export function verifyRemoteAgentArtifactBytes(
  artifact: RemoteAgentArtifact,
  bytes: Uint8Array,
): void {
  if (bytes.byteLength !== artifact.sizeBytes) {
    throw new RemoteAgentArtifactError(
      `Remote agent artifact size mismatch: expected ${artifact.sizeBytes}, received ${bytes.byteLength}.`,
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== artifact.sha256) {
    throw new RemoteAgentArtifactError("Remote agent artifact SHA-256 verification failed.");
  }
}

export function canonicalizeRemoteAgentArtifact(artifact: RemoteAgentArtifact): string {
  return [
    artifact.version,
    artifact.buildDigest,
    artifact.protocolMajor,
    artifact.protocolMinor,
    artifact.targetTriple,
    artifact.sizeBytes,
    artifact.sha256,
    artifact.bundledPath ?? "",
    artifact.url ?? "",
  ].join("\n");
}

export function verifyRemoteAgentArtifactSignature(
  artifact: RemoteAgentArtifact,
  trustStore: RemoteAgentArtifactTrustStore,
): void {
  const publicKey = trustStore[artifact.signature.keyId];
  if (!publicKey) {
    throw new RemoteAgentArtifactError(
      `No trusted public key exists for artifact key '${artifact.signature.keyId}'.`,
    );
  }
  const valid = verifyPinnedArtifactSignature({
    payload: Buffer.from(canonicalizeRemoteAgentArtifact(artifact)),
    publicKey,
    signature: artifact.signature.value,
  });
  if (!valid) {
    throw new RemoteAgentArtifactError("Remote agent artifact signature verification failed.");
  }
}
