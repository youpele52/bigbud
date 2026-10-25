import { createHash } from "node:crypto";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { ensureV2ThreadPrivateChild } from "./Orchestration.storage.ts";
import { acquireV2PluginPublicationLock } from "./PluginSetup.lock.ts";
import { v2NativePluginDirectory } from "./PluginSetup.fs.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";

/** App-private exact-root ownership precedes admission closure and the first native-directory/lock write. */
export async function closeV2PublicationBoundary(
  artifact: V2PluginSetupArtifact,
  root: string,
  authority: V2PluginSetupAuthority,
) {
  if (!authority.publication) return async () => {};
  const locks = await ensureV2ThreadPrivateChild(artifact.root, "activation-locks");
  const directory = await ensureV2ThreadPrivateChild(
    locks,
    createHash("sha256").update(root).digest("hex"),
  );
  const unlock = await acquireV2PluginPublicationLock(
    directory,
    await v2NativePluginDirectory(directory),
    root,
    artifact,
    authority,
    v2ThreadRegistration(artifact).family,
  );
  let releaseGate: (() => void) | undefined;
  try {
    releaseGate = await authority.publication.locked();
  } catch (error) {
    await authority.publication.joinPhysical?.();
    await unlock();
    throw error;
  }
  return async () => {
    try {
      releaseGate?.();
    } finally {
      await authority.publication?.joinPhysical?.();
      await unlock();
    }
  };
}
