import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RemoteAgentReleaseTarget = "x86_64-unknown-linux-gnu" | "aarch64-unknown-linux-gnu";

export interface RemoteAgentReleaseManifestInput {
  readonly version: string;
  readonly repository: string;
  readonly signingKeyId: string;
  readonly signingKeyPem: string;
  readonly assets: ReadonlyArray<{
    readonly targetTriple: RemoteAgentReleaseTarget;
    readonly path: string;
  }>;
}

export interface RemoteAgentReleaseManifest {
  readonly schemaVersion: 1;
  readonly artifacts: ReadonlyArray<{
    readonly version: string;
    readonly protocolMajor: 1;
    readonly protocolMinor: 1;
    readonly targetTriple: RemoteAgentReleaseTarget;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly signature: {
      readonly algorithm: "ed25519";
      readonly keyId: string;
      readonly value: string;
    };
    readonly url: string;
  }>;
}

export interface RemoteAgentInstallSource {
  readonly manifest: RemoteAgentReleaseManifest;
  readonly trustStore: Readonly<Record<string, string>>;
}

type UnsignedRemoteAgentArtifact = Omit<
  RemoteAgentReleaseManifest["artifacts"][number],
  "signature"
>;

function canonicalizeArtifact(artifact: UnsignedRemoteAgentArtifact): string {
  return [
    artifact.version,
    artifact.protocolMajor,
    artifact.protocolMinor,
    artifact.targetTriple,
    artifact.sizeBytes,
    artifact.sha256,
    "",
    artifact.url,
  ].join("\n");
}

function assertSafeReleaseValue(value: string, label: string, pattern: RegExp): void {
  if (!pattern.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
}

function signArtifact(
  artifact: UnsignedRemoteAgentArtifact,
  signingKeyPem: string,
  signingKeyId: string,
): RemoteAgentReleaseManifest["artifacts"][number] {
  const signature = sign(
    null,
    Buffer.from(canonicalizeArtifact(artifact)),
    createPrivateKey(signingKeyPem),
  ).toString("base64");
  return {
    ...artifact,
    signature: { algorithm: "ed25519", keyId: signingKeyId, value: signature },
  };
}

export function buildRemoteAgentReleaseManifest(
  input: RemoteAgentReleaseManifestInput,
): RemoteAgentReleaseManifest {
  assertSafeReleaseValue(input.version, "Release version", /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/);
  assertSafeReleaseValue(
    input.repository,
    "GitHub repository",
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
  );
  assertSafeReleaseValue(input.signingKeyId, "Signing key ID", /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  if (input.signingKeyPem.length === 0) throw new Error("Remote-agent signing key is required.");
  if (input.assets.length !== 2) {
    throw new Error("The remote-agent release must contain exactly two target assets.");
  }
  if (new Set(input.assets.map((asset) => asset.targetTriple)).size !== input.assets.length) {
    throw new Error("The remote-agent release contains duplicate target assets.");
  }

  const artifacts = input.assets.map(({ targetTriple, path }) => {
    const bytes = readFileSync(path);
    if (bytes.byteLength === 0) throw new Error(`Remote-agent asset '${path}' is empty.`);
    const assetName = `bigbud-remote-agent-${input.version}-${targetTriple}`;
    const artifact = {
      version: input.version,
      protocolMajor: 1 as const,
      protocolMinor: 1 as const,
      targetTriple,
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      url: `https://github.com/${input.repository}/releases/download/v${input.version}/${assetName}`,
    };
    return signArtifact(artifact, input.signingKeyPem, input.signingKeyId);
  });

  return { schemaVersion: 1, artifacts };
}

export function buildRemoteAgentInstallSource(input: {
  readonly manifest: RemoteAgentReleaseManifest;
  readonly signingKeyId: string;
  readonly signingKeyPem: string;
}): RemoteAgentInstallSource {
  const publicKey = createPublicKey(createPrivateKey(input.signingKeyPem))
    .export({ type: "spki", format: "pem" })
    .toString();
  return {
    manifest: input.manifest,
    trustStore: { [input.signingKeyId]: publicKey },
  };
}

function parseAssetSpec(value: string): RemoteAgentReleaseManifestInput["assets"][number] {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid --asset value '${value}'. Expected TARGET=PATH.`);
  }
  const targetTriple = value.slice(0, separator);
  if (targetTriple !== "x86_64-unknown-linux-gnu" && targetTriple !== "aarch64-unknown-linux-gnu") {
    throw new Error(`Unsupported remote-agent target '${targetTriple}'.`);
  }
  return { targetTriple, path: value.slice(separator + 1) };
}

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function runCli(): void {
  const outputPath = resolve(argumentValue("--output"));
  const installSourceOutputIndex = process.argv.indexOf("--install-source-output");
  const installSourceOutput =
    installSourceOutputIndex >= 0 ? process.argv[installSourceOutputIndex + 1] : undefined;
  const assets = process.argv
    .filter((argument) => argument.startsWith("--asset="))
    .map((argument) => parseAssetSpec(argument.slice("--asset=".length)));
  const manifest = buildRemoteAgentReleaseManifest({
    version: argumentValue("--version"),
    repository: argumentValue("--repository"),
    signingKeyId: process.env.BIGBUD_REMOTE_AGENT_SIGNING_KEY_ID ?? "",
    signingKeyPem: process.env.BIGBUD_REMOTE_AGENT_SIGNING_KEY ?? "",
    assets,
  });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (installSourceOutput) {
    const installSource = buildRemoteAgentInstallSource({
      manifest,
      signingKeyId: process.env.BIGBUD_REMOTE_AGENT_SIGNING_KEY_ID ?? "",
      signingKeyPem: process.env.BIGBUD_REMOTE_AGENT_SIGNING_KEY ?? "",
    });
    writeFileSync(resolve(installSourceOutput), `${JSON.stringify(installSource, null, 2)}\n`);
  }
  console.log(`Wrote remote-agent release manifest to ${outputPath}`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
