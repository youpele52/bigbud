import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseRemoteAgentArtifactManifest,
  selectRemoteAgentArtifact,
  verifyRemoteAgentArtifactBytes,
  verifyRemoteAgentArtifactSignature,
  type RemoteAgentTargetTriple,
} from "@bigbud/shared/remoteAgentArtifact";

interface AssetSpec {
  readonly targetTriple: RemoteAgentTargetTriple;
  readonly path: string;
}

export function verifyRemoteAgentReleaseAssets(input: {
  readonly manifestBytes: Uint8Array;
  readonly signingKeyPem: string;
  readonly signingKeyId: string;
  readonly assets: ReadonlyArray<AssetSpec>;
  readonly installSourceBytes?: Uint8Array;
}): void {
  const manifest = parseRemoteAgentArtifactManifest(
    JSON.parse(new TextDecoder().decode(input.manifestBytes)) as unknown,
  );
  const publicKey = createPublicKey(input.signingKeyPem)
    .export({ type: "spki", format: "pem" })
    .toString();
  const trustStore = { [input.signingKeyId]: publicKey };
  for (const asset of input.assets) {
    const artifact = selectRemoteAgentArtifact(manifest, asset.targetTriple);
    if (artifact.url === undefined) {
      throw new Error(`Manifest artifact for ${asset.targetTriple} has no release URL.`);
    }
    verifyRemoteAgentArtifactSignature(artifact, trustStore);
    verifyRemoteAgentArtifactBytes(artifact, readFileSync(asset.path));
  }
  if (new Set(input.assets.map((asset) => asset.targetTriple)).size !== manifest.artifacts.length) {
    throw new Error("Manifest and packaged remote-agent target sets do not match.");
  }
  if (input.installSourceBytes) {
    const value = JSON.parse(new TextDecoder().decode(input.installSourceBytes)) as {
      manifest?: unknown;
      trustStore?: Record<string, unknown>;
    };
    const installManifest = parseRemoteAgentArtifactManifest(value.manifest);
    if (JSON.stringify(installManifest) !== JSON.stringify(manifest)) {
      throw new Error("Install source manifest does not match the published manifest.");
    }
    if (value.trustStore?.[input.signingKeyId] !== publicKey) {
      throw new Error("Install source does not contain the expected release public key.");
    }
  }
}

function argumentValue(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}

function parseAssetSpec(value: string): AssetSpec {
  const separator = value.indexOf("=");
  const targetTriple = value.slice(0, separator);
  if (
    separator <= 0 ||
    (targetTriple !== "x86_64-unknown-linux-gnu" && targetTriple !== "aarch64-unknown-linux-gnu")
  ) {
    throw new Error(`Invalid --asset value '${value}'.`);
  }
  return { targetTriple, path: value.slice(separator + 1) };
}

function runCli(): void {
  const assets = process.argv
    .filter((argument) => argument.startsWith("--asset="))
    .map((argument) => parseAssetSpec(argument.slice("--asset=".length)));
  verifyRemoteAgentReleaseAssets({
    manifestBytes: readFileSync(resolve(argumentValue("--manifest"))),
    installSourceBytes: readFileSync(resolve(argumentValue("--install-source"))),
    signingKeyPem: process.env.BIGBUD_REMOTE_AGENT_SIGNING_KEY ?? "",
    signingKeyId: process.env.BIGBUD_REMOTE_AGENT_SIGNING_KEY_ID ?? "",
    assets,
  });
  console.log("Verified remote-agent install source, manifest signatures, and packaged bytes.");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
