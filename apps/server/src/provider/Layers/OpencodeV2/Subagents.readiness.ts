import path from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { v2Request, type OpencodeV2Client } from "./Client.ts";
import { nativeFamilyEntry, type V2NativeFamilyArtifact } from "./Subagents.artifact.ts";
import type { V2NativeRuntimeProof } from "./NativeCompatibility.types.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { readV2NativePluginFile } from "./PluginSetup.fs.ts";
import { nativeFamilyHash, V2_NATIVE_FAMILY_PROTOCOL } from "./Subagents.protocol.ts";

const Info = Schema.Struct({
  familyABI: Schema.optionalKey(Schema.String),
  familySourceDigest: Schema.optionalKey(Schema.String),
  protocol: Schema.Literal(V2_NATIVE_FAMILY_PROTOCOL),
  artifactDigest: Schema.String,
  setupInstanceId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  nativeVersion: Schema.String,
});

/** Exact loaded artifact/source/namespace proof, not mere RPC reachability or config presence. */
export async function verifyV2NativeFamilySource(
  artifact: V2NativeFamilyArtifact,
  client: OpencodeV2Client,
  proof: V2NativeRuntimeProof,
) {
  proof.assertCurrent();
  await artifact.verify();
  const inventory = await v2Request("native family source", (signal) =>
    client.plugin.list({ location: { directory: proof.directory } }, { signal }),
  );
  if (
    inventory.location.directory !== proof.directory ||
    inventory.data.length > 1000 ||
    new Set(inventory.data.map((entry) => entry.id)).size !== inventory.data.length
  )
    throw new Error("V2 native family plugin inventory is ambiguous.");
  for (const plugin of inventory.data) {
    if (plugin.source.type === "builtin") continue;
    if (plugin.id === `bigbud.thread.v2.${artifact.issuer}`) continue; // Independently verified by canonical readiness, not accepted as child authority.
    if (
      plugin.id !== artifact.rpcID ||
      plugin.state.status !== "active" ||
      plugin.source.type !== "local"
    )
      throw new Error("V2 native family final-clamp stack contains an unqualified plugin.");
  }
  const matches = inventory.data.filter((plugin) => plugin.id === artifact.rpcID);
  if (
    matches.length !== 1 ||
    matches[0]!.source.type !== "local" ||
    matches[0]!.state.status !== "active"
  )
    throw new Error("V2 native family guard is not loaded exactly once.");
  const source = matches[0]!.source.path;
  if (
    ![
      artifact.directory,
      fileURLToPath(artifact.entryUri),
      path.join(artifact.directory, "server.js"),
    ].includes(source)
  ) {
    if (source !== path.join(proof.root, "plugins", artifact.filename))
      throw new Error("V2 native family source is foreign.");
    const records = await V2ThreadRecords.open(
      artifact.root,
      "native-family-publications",
      artifact.privateKey,
      artifact.publicKey,
    );
    const saved = await records.read(JSON.stringify([proof.root, artifact.filename]));
    const file = await readV2NativePluginFile(source, true, 16384);
    const expected = nativeFamilyEntry(artifact, proof.root);
    if (
      !saved ||
      !file ||
      nativeFamilyHash(saved.value) !==
        nativeFamilyHash({
          metadata: expected.metadata,
          signature: expected.signature,
          identity: file.identity,
        }) ||
      file.content !== expected.content
    )
      throw new Error("V2 native family managed entry lacks signed exact-source provenance.");
  }
  proof.assertCurrent();
  return {
    inventory,
    decodeInfo: (value: unknown) => {
      const info = Schema.decodeUnknownSync(Info)(value, { onExcessProperty: "error" });
      if (
        info.artifactDigest !== artifact.artifactDigest ||
        info.nativeVersion !== proof.nativeVersion
      )
        throw new Error("V2 native family loaded artifact/version mismatch.");
      return info;
    },
  };
}
