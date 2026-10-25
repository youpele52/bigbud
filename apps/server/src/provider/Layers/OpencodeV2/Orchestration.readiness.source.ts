import { fileURLToPath } from "node:url";
import path from "node:path";
import * as Schema from "effect/Schema";
import { v2Request, type OpencodeV2Client } from "./Client.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import {
  V2PluginPublication,
  v2PublicationFilename,
  v2PluginContentHash,
} from "./PluginSetup.record.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { readV2NativePluginFile } from "./PluginSetup.fs.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";

/** Private bytes alone do not establish the native entry's source, uniqueness or exact managed predecessor. */
export async function assertV2NativeThreadSource(
  artifact: V2PluginSetupArtifact,
  client: OpencodeV2Client,
  directory: string,
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
  const records = await V2ThreadRecords.open(
    artifact.root,
    "installations",
    artifact.privateKey,
    artifact.publicKey,
  );
  for (const signed of await records.entries()) {
    const record = Schema.decodeUnknownSync(V2PluginPublication)(signed.value, {
      onExcessProperty: "error",
    });
    if (source !== path.join(record.root, "plugins", v2PublicationFilename(record))) continue;
    if (
      record.phase !== "committed" ||
      record.next.issuer !== artifact.issuer ||
      record.next.artifactDigest !== artifact.artifactDigest ||
      !record.nextIdentity
    )
      break;
    const file = await readV2NativePluginFile(source, true, 16384);
    if (
      file &&
      file.content === record.next.content &&
      v2PluginContentHash(file.content) === record.next.hash &&
      file.identity.dev === record.nextIdentity.dev &&
      file.identity.ino === record.nextIdentity.ino
    )
      return;
    break;
  }
  throw new Error(
    "V2 required bootstrap source lacks exact signed managed-entry proof; no history mutation.",
  );
}
