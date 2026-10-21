import path from "node:path";
import { pathToFileURL } from "node:url";
import { sign } from "node:crypto";
import {
  openV2ThreadIssuer,
  ensureV2ThreadPrivateChild,
  readV2ThreadPrivateFile,
  writeV2ThreadPrivateFile,
  listV2ThreadPrivateDirectory,
} from "./Orchestration.storage.ts";
import { renderV2ThreadCrypto } from "./Orchestration.plugin.crypto.ts";
import { renderV2NativeFamilyRegistry } from "./Subagents.native.registry.ts";
import { renderV2NativeFamilyPlugin } from "./Subagents.native.plugin.ts";
import { nativeFamilyHash, V2_NATIVE_FAMILY_PROTOCOL } from "./Subagents.protocol.ts";

/** Separate signed content-addressed artifact; never edits or impersonates a thread bootstrap. */
export async function exportV2NativeFamilyArtifact(stateDir: string) {
  const signer = await openV2ThreadIssuer(stateDir);
  const root = await ensureV2ThreadPrivateChild(signer.root, "native-family-artifacts");
  const modules = {
    "server.js": 'export {default} from "./index.mjs";\n',
    "package.json": JSON.stringify({
      name: "bigbud-native-subagents-local",
      private: true,
      type: "module",
      version: "1.0.0",
    }),
    "index.mjs": renderV2NativeFamilyPlugin(signer.issuer),
    "registry.mjs": renderV2NativeFamilyRegistry(signer.publicKey, signer.issuer),
    "crypto.mjs": renderV2ThreadCrypto(signer.encryptionPublicKey),
  };
  const hashes = Object.entries(modules).map(([name, content]) => [
    name,
    nativeFamilyHash(content),
  ]);
  const artifactDigest = nativeFamilyHash([
    V2_NATIVE_FAMILY_PROTOCOL,
    "@opencode/plugin@2.0.26",
    hashes,
  ]);
  const directory = await ensureV2ThreadPrivateChild(root, artifactDigest);
  const manifestValue = {
    protocol: V2_NATIVE_FAMILY_PROTOCOL,
    publicAbi: "@opencode/plugin@2.0.26",
    issuer: signer.issuer,
    artifactDigest,
    hashes,
  };
  const contents = {
    ...modules,
    "manifest.json": JSON.stringify({
      ...manifestValue,
      signature: sign(null, Buffer.from(JSON.stringify(manifestValue)), signer.privateKey).toString(
        "base64url",
      ),
    }),
  };
  for (const [name, content] of Object.entries(contents)) {
    const filename = path.join(directory, name);
    try {
      await readV2ThreadPrivateFile(filename);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      try {
        await writeV2ThreadPrivateFile(filename, content);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    }
  }
  const verify = async () => {
    if ((await listV2ThreadPrivateDirectory(directory)).length !== Object.keys(contents).length)
      throw new Error("V2 native family artifact inventory mismatch.");
    for (const [name, content] of Object.entries(contents))
      if ((await readV2ThreadPrivateFile(path.join(directory, name))) !== content)
        throw new Error("V2 native family artifact bytes mismatch.");
  };
  await verify();
  return {
    ...signer,
    directory,
    artifactDigest,
    verify,
    rpcID: `${V2_NATIVE_FAMILY_PROTOCOL}.${signer.issuer}`,
    filename: `bigbud-native-subagents-${signer.issuer}-${artifactDigest}.js`,
    entryUri: pathToFileURL(path.join(directory, "index.mjs")).href,
  };
}
export type V2NativeFamilyArtifact = Awaited<ReturnType<typeof exportV2NativeFamilyArtifact>>;
export function nativeFamilyEntry(artifact: V2NativeFamilyArtifact, root: string) {
  const metadata = [
    V2_NATIVE_FAMILY_PROTOCOL,
    root,
    artifact.issuer,
    artifact.artifactDigest,
    artifact.entryUri,
  ];
  const signature = sign(null, Buffer.from(JSON.stringify(metadata)), artifact.privateKey).toString(
    "base64url",
  );
  return {
    metadata,
    signature,
    content: `// bigbud-native-family ${JSON.stringify({ metadata, signature })}\nexport {default} from ${JSON.stringify(artifact.entryUri)};\n`,
  };
}
