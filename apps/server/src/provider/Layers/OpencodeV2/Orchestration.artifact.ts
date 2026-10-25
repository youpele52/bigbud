import { createHash, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { renderV2ThreadIdentity } from "./Orchestration.plugin.identity.ts";
import { renderV2ThreadRegistry } from "./Orchestration.plugin.registry.ts";
import { renderV2ThreadPlugin } from "./Orchestration.plugin.ts";
import { renderV2ThreadCrypto } from "./Orchestration.plugin.crypto.ts";
import { renderV2LegacyCleanup } from "./Orchestration.plugin.legacy.ts";
import {
  V2_BOOTSTRAP_COMPATIBILITY,
  V2_COMPATIBILITY_DIGEST,
} from "./Orchestration.compatibility.ts";
import { V2_THREAD_RPC } from "./Orchestration.protocol.ts";
import {
  openV2ThreadIssuer,
  ensureV2ThreadPrivateChild,
  v2ThreadPrivateDirectory,
  readV2ThreadPrivateFile,
  writeV2ThreadPrivateFile,
  listV2ThreadPrivateDirectory,
} from "./Orchestration.storage.ts";
import { publishV2WindowsArtifact } from "./Orchestration.artifact.windows.ts";

const digest = (content: string) => createHash("sha256").update(content).digest("hex");

/** Digest final module bytes only; nominal runtime URL identity is not byte attestation. */
export async function exportV2ThreadArtifact(stateDir: string) {
  const signer = await openV2ThreadIssuer(stateDir);
  const root = await ensureV2ThreadPrivateChild(signer.root, "artifacts");
  const modules: Record<string, string> = {
    "server.js": 'export { default } from "./index.mjs";\n',
    "package.json": JSON.stringify({
      name: "bigbud-opencode-thread-tools-local",
      private: true,
      version: "1.0.0",
      type: "module",
    }),
    "identity.mjs": renderV2ThreadIdentity(signer.publicKey),
    "crypto.mjs": renderV2ThreadCrypto(signer.encryptionPublicKey),
    "registry.mjs": renderV2ThreadRegistry(),
    "legacy.mjs": renderV2LegacyCleanup(signer.publicKey),
    "index.mjs": renderV2ThreadPlugin(),
  };
  const hashes = Object.entries(modules)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, content]) => [name, digest(content)]);
  const artifactDigest = digest(JSON.stringify(hashes));
  const manifestValue = {
    protocol: V2_THREAD_RPC,
    publicAbi: "@opencode/plugin@2.0.26",
    issuer: signer.issuer,
    artifactDigest,
    bootstrapDigest: artifactDigest,
    compatibility: V2_BOOTSTRAP_COMPATIBILITY,
    compatibilityDigest: V2_COMPATIBILITY_DIGEST,
    encryptionKeyId: digest(signer.encryptionPublicKey),
    hashes,
  };
  const manifest = JSON.stringify({
    ...manifestValue,
    signature: sign(
      null,
      Buffer.from(JSON.stringify(["bigbud.thread.bootstrap.manifest.v1", manifestValue])),
      signer.privateKey,
    ).toString("base64url"),
  });
  const contents = { ...modules, "manifest.json": manifest };
  const directory = path.join(root, artifactDigest);
  async function verify() {
    await v2ThreadPrivateDirectory(directory);
    const names = await listV2ThreadPrivateDirectory(directory);
    if (names.length !== Object.keys(contents).length)
      throw new Error("V2 thread-tools artifact inventory rejected.");
    for (const [name, expected] of Object.entries(contents))
      if ((await readV2ThreadPrivateFile(path.join(directory, name))) !== expected)
        throw new Error("V2 thread-tools artifact content collision.");
  }
  try {
    if (process.platform === "win32") await v2ThreadPrivateDirectory(directory);
    else await lstat(directory);
    await verify();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    if (process.platform === "win32") {
      await publishV2WindowsArtifact(directory, contents, verify);
      return result();
    }
    const staging = await mkdtemp(path.join(root, "stage."));
    try {
      for (const [name, content] of Object.entries(contents))
        await writeV2ThreadPrivateFile(path.join(staging, name), content);
      // mkdir is the portable no-replace publication reservation. The manifest is copied last;
      // incomplete concurrent publications fail verification, never overwrite another directory.
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        await verify();
        return result();
      }
      for (const [name, content] of Object.entries(contents))
        await writeV2ThreadPrivateFile(path.join(directory, name), content);
      const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await verify();
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return result();

  function result() {
    return {
      ...signer,
      directory,
      artifactDigest,
      bootstrapDigest: artifactDigest,
      bootstrapAbi: V2_BOOTSTRAP_COMPATIBILITY.bootstrapAbi as string,
      compatibility:
        V2_BOOTSTRAP_COMPATIBILITY as import("./Orchestration.compatibility.ts").V2BootstrapCompatibility,
      compatibilityDigest: V2_COMPATIBILITY_DIGEST,
      entryUri: pathToFileURL(path.join(directory, "index.mjs")).href,
      pluginUri: pathToFileURL(directory).href,
      verify,
    };
  }
}
