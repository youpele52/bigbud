import { mkdtemp, mkdir, writeFile, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  canonicalBackendGraphPayload,
  decodeBackendGraphManifest,
} from "../remote-backend/backendGraph.manifest.ts";
import {
  canonicalizeRemoteAgentArtifact,
  type RemoteAgentArtifact,
} from "@bigbud/shared/remoteAgentArtifact";
import type { BackendSetupCliInput } from "./cli.backend.inputs.ts";

export async function backendSetupInputFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "bigbud-setup-cli-input-")));
  await chmod(directory, 0o700);
  const root = join(directory, "graph");
  await mkdir(root, { mode: 0o700 });
  const files = [];
  for (const [name, raw] of [
    ["node", "explicit-test-node"],
    ["bin.mjs", "explicit-test-entry"],
  ]) {
    const bytes = Buffer.from(raw!);
    await writeFile(join(root, name!), bytes, { mode: name === "node" ? 0o700 : 0o600 });
    files.push({
      path: name!,
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      executable: name === "node",
    });
  }
  const key = generateKeyPairSync("ed25519");
  const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signature = { algorithm: "ed25519" as const, keyId: "fixture-only", value: "A".repeat(88) };
  const manifest = decodeBackendGraphManifest({
    revision: 1,
    version: "fixture-1",
    buildDigest: "a".repeat(64),
    target: process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu",
    node: "node",
    entry: "bin.mjs",
    files,
    signature,
  });
  const graph = {
    ...manifest,
    signature: {
      ...signature,
      value: sign(null, canonicalBackendGraphPayload(manifest), key.privateKey).toString("base64"),
    },
  };
  const rust: RemoteAgentArtifact = {
    version: "fixture-1",
    buildDigest: "fixture",
    protocolMajor: 1,
    protocolMinor: 7,
    targetTriple: manifest.target,
    sizeBytes: 3,
    sha256: createHash("sha256").update("elf").digest("hex"),
    bundledPath: join(directory, "rust"),
    signature,
  };
  const artifact = {
    ...rust,
    signature: {
      ...signature,
      value: sign(
        null,
        Buffer.from(canonicalizeRemoteAgentArtifact(rust)),
        key.privateKey,
      ).toString("base64"),
    },
  };
  const input: BackendSetupCliInput = {
    graphRoot: root,
    graphManifest: join(directory, "graph.json"),
    rustManifest: join(directory, "rust.json"),
    trustedKeys: join(directory, "keys.json"),
    backendHome: join(directory, "backend"),
    requestId: "11111111-1111-4111-8111-111111111111",
    confirmFreshSetup: true,
    restart: "on-failure",
  };
  for (const [path, value] of [
    [input.graphManifest, graph],
    [input.rustManifest, { schemaVersion: 1, artifacts: [artifact] }],
    [input.trustedKeys, { "fixture-only": publicKey }],
  ] as const)
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return { directory, input, publicKey, graph };
}
