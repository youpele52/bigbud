import { createHash, verify } from "node:crypto";
import { listV2ThreadPrivateDirectory as readdir } from "./Orchestration.storage.ts";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { exportV2ThreadArtifact } from "./Orchestration.artifact.ts";
import { knownV2BootstrapCompatibility } from "./Orchestration.compatibility.ts";
import { readV2ThreadPrivateFile, v2ThreadPrivateDirectory } from "./Orchestration.storage.ts";

/** Retained N identity requires the app's signed exact hash manifest, not self-reported native paths. */
export async function readV2RetainedArtifact(
  preferred: Awaited<ReturnType<typeof exportV2ThreadArtifact>>,
  bootstrapDigest: string,
) {
  if (!/^[a-f0-9]{64}$/.test(bootstrapDigest))
    throw new Error("V2 retained bootstrap digest rejected.");
  if (bootstrapDigest === preferred.artifactDigest) {
    await preferred.verify();
    return preferred;
  }
  const directory = path.join(path.dirname(preferred.directory), bootstrapDigest);
  const check = async () => {
    await v2ThreadPrivateDirectory(directory);
    const raw = JSON.parse(
      await readV2ThreadPrivateFile(path.join(directory, "manifest.json")),
    ) as Record<string, unknown>;
    const { signature, ...manifest } = raw;
    if (
      Object.keys(raw).toSorted().join() !==
        "artifactDigest,bootstrapDigest,compatibility,compatibilityDigest,encryptionKeyId,hashes,issuer,protocol,publicAbi,signature" ||
      manifest.issuer !== preferred.issuer ||
      manifest.artifactDigest !== bootstrapDigest ||
      manifest.bootstrapDigest !== bootstrapDigest ||
      manifest.protocol !== "bigbud.thread.v1" ||
      manifest.publicAbi !== "@opencode/plugin@2.0.26" ||
      manifest.encryptionKeyId !==
        createHash("sha256").update(preferred.encryptionPublicKey).digest("hex") ||
      typeof signature !== "string" ||
      !/^[A-Za-z0-9_-]{86}$/.test(signature) ||
      !verify(
        null,
        Buffer.from(JSON.stringify(["bigbud.thread.bootstrap.manifest.v1", manifest])),
        preferred.publicKey,
        Buffer.from(signature, "base64url"),
      )
    )
      throw new Error(
        "V2 retained bootstrap is not a signed compatible bundled contract; no native history changes.",
      );
    const compatibility = knownV2BootstrapCompatibility(
      manifest.compatibility,
      manifest.compatibilityDigest,
    );
    const hashes = manifest.hashes as unknown;
    const modules = [
      "crypto.mjs",
      "identity.mjs",
      "index.mjs",
      "legacy.mjs",
      "package.json",
      "registry.mjs",
      "server.js",
    ];
    if (
      !Array.isArray(hashes) ||
      hashes.length !== modules.length ||
      hashes.some(
        (pair, index) =>
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          pair[0] !== modules[index] ||
          typeof pair[1] !== "string" ||
          !/^[a-f0-9]{64}$/.test(pair[1]),
      )
    )
      throw new Error("V2 retained bootstrap inventory rejected.");
    if (
      createHash("sha256").update(JSON.stringify(hashes)).digest("hex") !== bootstrapDigest ||
      (await readdir(directory)).toSorted().join() !==
        [...modules, "manifest.json"].toSorted().join()
    )
      throw new Error("V2 retained bootstrap manifest/module closure changed.");
    for (const [name, digest] of hashes) {
      const content = await readV2ThreadPrivateFile(path.join(directory, name));
      if (
        createHash("sha256").update(content).digest("hex") !== digest ||
        content.split("\n").length > 401
      )
        throw new Error("V2 retained bootstrap byte proof changed.");
    }
    return { compatibility, compatibilityDigest: manifest.compatibilityDigest as string };
  };
  const selected = await check();
  return {
    root: preferred.root,
    issuer: preferred.issuer,
    privateKey: preferred.privateKey,
    publicKey: preferred.publicKey,
    encryptionPrivateKey: preferred.encryptionPrivateKey,
    encryptionPublicKey: preferred.encryptionPublicKey,
    directory,
    artifactDigest: bootstrapDigest,
    bootstrapDigest,
    bootstrapAbi: selected.compatibility.bootstrapAbi,
    compatibility: selected.compatibility,
    compatibilityDigest: selected.compatibilityDigest,
    entryUri: pathToFileURL(path.join(directory, "index.mjs")).href,
    pluginUri: pathToFileURL(directory).href,
    verify: async () => {
      await check();
    },
  };
}
