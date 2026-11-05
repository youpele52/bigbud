import { createHash, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import type { V2BootstrapCompatibility } from "./Orchestration.compatibility.ts";
import { readV2RetainedArtifact } from "./Orchestration.artifact.retained.ts";
import { ensureV2ThreadPrivateChild, writeV2ThreadPrivateFile } from "./Orchestration.storage.ts";

export const V2_PREVIOUS_BOOTSTRAP_FIXTURE_SHA256 =
  "f9a12669c82fad2e8355c969433438a2856fd2905495268775373fa797fafbf3";

/** Exact pinned c015538b2a renderer output with disposable keys; not a native qualification.
 * Check regeneration with scripts/generateThreadToolRetainedBootstrapFixture.ts --check. */
export async function makeV2PreviousBootstrapFixture(preferred: V2PluginSetupArtifact) {
  const source = await readFile(
    new URL("./Orchestration.bootstrap.previous.ndjson", import.meta.url),
    "utf8",
  );
  if (createHash("sha256").update(source).digest("hex") !== V2_PREVIOUS_BOOTSTRAP_FIXTURE_SHA256)
    throw new Error(
      "Pinned previous bootstrap fixture integrity changed; regenerate and review source provenance.",
    );
  const records = source
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (records[0].commit !== "c015538b2ad999a1a76fb62186b8d8a3c540d9f8")
    throw new Error("Pinned previous bootstrap source ref changed.");
  const { descriptor: compatibility, digest: compatibilityDigest } = records[1] as {
    descriptor: V2BootstrapCompatibility;
    digest: string;
  };
  const hash = (content: string) => createHash("sha256").update(content).digest("hex");
  const modules = records
    .slice(2)
    .map(
      ({ name, content }: { name: string; content: string }) =>
        [
          name,
          content
            .replaceAll(JSON.stringify("FIXTURE_PUBLIC_KEY"), JSON.stringify(preferred.publicKey))
            .replaceAll(
              JSON.stringify("FIXTURE_ENCRYPTION_KEY"),
              JSON.stringify(preferred.encryptionPublicKey),
            ),
        ] as const,
    );
  const hashes = modules.map(([name, content]) => [name, hash(content)]);
  const artifactDigest = hash(JSON.stringify(hashes));
  const directory = await ensureV2ThreadPrivateChild(
    path.dirname(preferred.directory),
    artifactDigest,
  );
  const manifest = {
    protocol: "bigbud.thread.v1",
    publicAbi: "@opencode/plugin@2.0.26",
    issuer: preferred.issuer,
    artifactDigest,
    bootstrapDigest: artifactDigest,
    compatibility,
    compatibilityDigest,
    encryptionKeyId: hash(preferred.encryptionPublicKey),
    hashes,
  };
  for (const [name, content] of modules)
    await writeV2ThreadPrivateFile(path.join(directory, name), content);
  await writeV2ThreadPrivateFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      ...manifest,
      signature: sign(
        null,
        Buffer.from(JSON.stringify(["bigbud.thread.bootstrap.manifest.v1", manifest])),
        preferred.privateKey,
      ).toString("base64url"),
    }),
  );
  return {
    ...preferred,
    directory,
    artifactDigest,
    bootstrapDigest: artifactDigest,
    compatibility,
    compatibilityDigest,
    bootstrapAbi: compatibility.bootstrapAbi,
    entryUri: pathToFileURL(path.join(directory, "index.mjs")).href,
    pluginUri: pathToFileURL(directory).href,
    verify: async () => {
      await (await readV2RetainedArtifact(preferred, artifactDigest)).verify();
    },
  };
}
