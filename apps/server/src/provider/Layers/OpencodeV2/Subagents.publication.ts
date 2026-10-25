import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  v2NativePluginDirectory,
  ensureV2NativePluginsDirectory,
  readV2NativePluginFile,
  removeV2NativePluginStaging,
} from "./PluginSetup.fs.ts";
import {
  stageV2NativePlugin,
  commitV2NativePlugin,
  finishV2NativePluginDirectory,
  type V2PluginStaging,
} from "./PluginSetup.staging.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { nativeFamilyEntry, type V2NativeFamilyArtifact } from "./Subagents.artifact.ts";
import { nativeFamilyHash } from "./Subagents.protocol.ts";
import { closeV2PublicationBoundary } from "./PluginSetup.publication.boundary.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";

/** First publication only, through the existing native handle/staging authority boundary.
 * No config rewrites, reloads, replacement of old artifacts or overwrite of foreign filenames.
 */
export async function publishV2NativeFamilyArtifact(
  artifact: V2NativeFamilyArtifact,
  root: string,
  authority: V2PluginSetupAuthority,
  canonical: V2PluginSetupArtifact,
) {
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  if (!authority.publication)
    throw new Error("V2 native family publication requires a held activation writer gate.");
  await artifact.verify();
  const rootIdentity = await v2NativePluginDirectory(root);
  const records = await V2ThreadRecords.open(
    artifact.root,
    "native-family-publications",
    artifact.privateKey,
    artifact.publicKey,
  );
  const { metadata, signature, content } = nativeFamilyEntry(artifact, root);
  const key = JSON.stringify([root, artifact.filename]);
  await authority.publication.prepare();
  const releaseBoundary = await closeV2PublicationBoundary(canonical, root, authority);
  try {
    authority.publication.assertGate();
    const plugins = await ensureV2NativePluginsDirectory(root, rootIdentity, authority);
    const filename = path.join(plugins.directory, artifact.filename);
    const saved = await records.read(key);
    const existing = await readV2NativePluginFile(filename, true, 16384);
    if (existing) {
      if (
        !saved ||
        existing.content !== content ||
        nativeFamilyHash(saved.value) !==
          nativeFamilyHash({ metadata, signature, identity: existing.identity })
      )
        throw new Error("V2 native family filename collision/changed provenance preserved.");
      return;
    }
    if (saved)
      throw new Error("V2 native family publication was removed; no automatic restoration.");
    // Signed reservation precedes creation. Interrupted first publication is operator-recoverable,
    // never silently overwritten or interpreted as proof that an executable was loaded.
    const revision = await records.replace(key, undefined, {
      metadata,
      signature,
      phase: "reserved",
    });
    const temporary = path.join(
      plugins.directory,
      `.bigbud-native-family.${randomBytes(16).toString("hex")}.pending`,
    );
    let staged: V2PluginStaging | undefined;
    try {
      await stageV2NativePlugin(temporary, content, plugins, authority, (value) => {
        staged = value;
      });
      const read = await readV2NativePluginFile(temporary, true, 16384);
      if (!read || read.content !== content) throw new Error("V2 native family staging mismatch.");
      await authority.publication.beforeMutation();
      authority.publication.assertGate();
      authority.assertCurrent();
      if (await readV2NativePluginFile(filename, true, 16384))
        throw new Error("V2 native family concurrent publication preserved.");
      await commitV2NativePlugin(temporary, filename, read, undefined, plugins.identity, authority);
      if (staged) {
        await removeV2NativePluginStaging(temporary, staged, () => {
          authority.assertCurrent();
          authority.publication!.assertGate();
        });
        staged = undefined;
      }
      await finishV2NativePluginDirectory(plugins.directory, plugins.identity);
      const committed = await readV2NativePluginFile(filename, true, 16384);
      if (!committed || committed.content !== content)
        throw new Error("V2 native family publication acknowledgement uncertain.");
      await records.replace(key, revision, { metadata, signature, identity: committed.identity });
    } finally {
      if (staged)
        await removeV2NativePluginStaging(temporary, staged, () => {
          authority.assertCurrent();
          authority.publication!.assertGate();
        });
    }
  } finally {
    await releaseBoundary();
  }
}
