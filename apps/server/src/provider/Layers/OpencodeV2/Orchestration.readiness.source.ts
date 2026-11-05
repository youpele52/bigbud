import { fileURLToPath } from "node:url";
import path from "node:path";
import * as Schema from "effect/Schema";
import { v2Request, type OpencodeV2Client } from "./Client.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import {
  V2PluginPublication,
  v2PublicationFilename,
  v2PluginContentHash,
  v2ManagedPluginEntry,
  v2PublicationProtocol,
} from "./PluginSetup.record.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { readV2NativePluginFile } from "./PluginSetup.fs.ts";
import { assertV2RetainedInstallationIdentity } from "./PluginSetup.revalidation.retained.ts";
import { readV2RetainedArtifact } from "./Orchestration.artifact.retained.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";

/** Private bytes alone do not establish the native entry's source, uniqueness or exact managed predecessor. */
export async function assertV2NativeThreadSource(
  artifact: V2PluginSetupArtifact,
  client: OpencodeV2Client,
  directory: string,
  root?: string,
) {
  const inventory = await v2Request(
    "required bootstrap source proof",
    (signal) => client.plugin.list({ location: { directory } }, { signal }),
    { timeoutMs: 5000 },
  );
  const matches = inventory.data.filter(
    (plugin) => plugin.id === v2ThreadRegistration(artifact).id,
  );
  if (
    inventory.data.length > 1000 ||
    matches.length !== 1 ||
    matches[0]?.state.status !== "active" ||
    matches[0].source.type !== "local"
  )
    throw new Error("V2 required bootstrap namespace/source is unverified or colliding.");
  const source = matches[0].source.path;
  if (
    [
      artifact.directory,
      fileURLToPath(artifact.entryUri),
      path.join(artifact.directory, "server.js"),
    ].includes(source)
  )
    return;
  const retained = await readV2ManagedThreadSource(artifact, source, root);
  if (retained?.artifactDigest === artifact.artifactDigest) return;
  throw new Error(
    "V2 required bootstrap source lacks exact signed managed-entry proof; no history mutation.",
  );
}

/** Resolve only a committed same-issuer publication with its original root/inode/content proof.
 * Reading it grants no replacement authority and never consults or retires enrollment owners. */
export async function readV2ManagedThreadSource(
  preferred: V2PluginSetupArtifact,
  source: string,
  root?: string,
) {
  const records = await V2ThreadRecords.open(
    preferred.root,
    "installations",
    preferred.privateKey,
    preferred.publicKey,
  );
  for (const signed of await records.entries()) {
    const record = Schema.decodeUnknownSync(V2PluginPublication)(signed.value, {
      onExcessProperty: "error",
    });
    if (source !== path.join(record.root, "plugins", v2PublicationFilename(record))) continue;
    if (
      record.phase !== "committed" ||
      (root !== undefined && record.root !== root) ||
      record.next.issuer !== preferred.issuer ||
      !record.nextIdentity
    )
      break;
    const artifact = await readV2RetainedArtifact(preferred, record.next.artifactDigest);
    const entry = v2ManagedPluginEntry(artifact, record.root);
    if (
      record.protocol !== v2PublicationProtocol(artifact) ||
      record.next.artifactDirectoryUri !== artifact.pluginUri ||
      record.next.content !== entry.content ||
      record.next.hash !== entry.hash
    )
      break;
    await assertV2RetainedInstallationIdentity(record, artifact);
    const file = await readV2NativePluginFile(source, true, 16384);
    if (
      file &&
      file.content === record.next.content &&
      v2PluginContentHash(file.content) === record.next.hash &&
      file.identity.dev === record.nextIdentity.dev &&
      file.identity.ino === record.nextIdentity.ino
    )
      return artifact;
    break;
  }
  return undefined;
}
