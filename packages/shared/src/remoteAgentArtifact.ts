import { createHash, createPublicKey, verify } from "node:crypto";

export const REMOTE_AGENT_SUPPORTED_PROTOCOL_MAJOR = 1;

export type RemoteAgentTargetTriple = "x86_64-unknown-linux-gnu" | "aarch64-unknown-linux-gnu";

export interface RemoteAgentArtifactSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface RemoteAgentArtifact {
  readonly version: string;
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
  if (artifact.protocolMajor !== REMOTE_AGENT_SUPPORTED_PROTOCOL_MAJOR) {
    throw new RemoteAgentArtifactError(
      `Artifact protocol major ${String(artifact.protocolMajor)} is unsupported.`,
    );
  }
  if (typeof artifact.protocolMinor !== "number" || !Number.isInteger(artifact.protocolMinor)) {
    throw new RemoteAgentArtifactError("Artifact protocolMinor must be an integer.");
  }
  if (
    artifact.targetTriple !== "x86_64-unknown-linux-gnu" &&
    artifact.targetTriple !== "aarch64-unknown-linux-gnu"
  ) {
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
  const artifacts = manifest.artifacts.map(parseArtifact);
  if (new Set(artifacts.map((artifact) => artifact.targetTriple)).size !== artifacts.length) {
    throw new RemoteAgentArtifactError("Remote agent artifact manifest has duplicate targets.");
  }
  return { schemaVersion: 1, artifacts };
}

export function selectRemoteAgentArtifact(
  manifest: RemoteAgentArtifactManifest,
  targetTriple: RemoteAgentTargetTriple,
  protocolMajor = REMOTE_AGENT_SUPPORTED_PROTOCOL_MAJOR,
): RemoteAgentArtifact {
  const artifact = manifest.artifacts.find(
    (candidate) =>
      candidate.targetTriple === targetTriple && candidate.protocolMajor === protocolMajor,
  );
  if (!artifact) {
    throw new RemoteAgentArtifactError(
      `No compatible remote agent artifact exists for ${targetTriple} and protocol ${protocolMajor}.`,
    );
  }
  return artifact;
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
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(canonicalizeRemoteAgentArtifact(artifact)),
      createPublicKey(publicKey),
      Buffer.from(artifact.signature.value, "base64"),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new RemoteAgentArtifactError("Remote agent artifact signature verification failed.");
  }
}
