import * as Schema from "effect/Schema";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import {
  V2PluginPublication,
  v2ManagedPluginEntry,
  v2ManagedPluginFilename,
  v2PublicationProtocol,
  type V2PluginSetupArtifact,
} from "./PluginSetup.record.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import { revalidateV2InstallationIdentity } from "./PluginSetup.revalidation.identity.ts";
import { v2NativePluginDirectory } from "./PluginSetup.fs.ts";
import { recoveryDigest } from "./RebootRecovery.schema.ts";
import { v2LockedInstallationArchiveKey } from "./PluginSetup.revalidation.archive.ts";

/** Archive exact prior evidence under the current backend lock. This is not a reboot proof. */
export async function recoverV2LockedInstallationIdentity(
  records: V2ThreadRecords,
  key: string,
  signed: NonNullable<Awaited<ReturnType<V2ThreadRecords["read"]>>>,
  artifact: V2PluginSetupArtifact,
  root: string,
) {
  const old = Schema.decodeUnknownSync(V2PluginPublication)(signed.value, {
    onExcessProperty: "error",
  });
  const wanted = v2ManagedPluginEntry(artifact, root);
  if (
    old.phase !== "committed" ||
    key !== JSON.stringify([root, v2ManagedPluginFilename(artifact)]) ||
    old.protocol !== v2PublicationProtocol(artifact) ||
    old.next.artifactDirectoryUri !== artifact.pluginUri ||
    old.root !== root ||
    old.next.issuer !== artifact.issuer ||
    old.next.content !== wanted.content ||
    old.next.hash !== wanted.hash ||
    old.next.artifactDigest !== artifact.artifactDigest
  )
    throw new Error("V2 installation identity maintenance requires the exact committed artifact.");
  const observe = () =>
    v2NativePluginDirectory(root).then((identity) =>
      revalidateV2InstallationIdentity(old, root, identity),
    );
  const revalidated = await observe();
  return {
    applyIdentityOnly: async (authority: V2PluginSetupAuthority) => {
      const assertOwner = authority.publication?.assertInstallationOwner;
      if (!assertOwner)
        throw new Error(
          "V2 installation identity maintenance requires same-host backend authority.",
        );
      const assertCurrent = () => {
        authority.assertCurrent();
        authority.signal.throwIfAborted();
        authority.publication!.assertGate();
      };
      const verify = async () => {
        assertCurrent();
        await assertOwner();
        if (
          recoveryDigest(await records.read(key)) !== recoveryDigest(signed) ||
          recoveryDigest(await observe()) !== recoveryDigest(revalidated)
        )
          throw new Error(
            "V2 installation identity changed during maintenance; original evidence preserved.",
          );
        assertCurrent();
      };
      await verify();
      await authority.publication!.beforeMutation();
      await verify();
      const archive = await records.sibling("recovery");
      const archiveKey = v2LockedInstallationArchiveKey(signed);
      const value = {
        format: "bigbud.thread.locked-installation-identity.v1",
        archivedSignedInstallation: signed,
        revalidated,
      };
      const existing = await archive.read(archiveKey);
      if (existing && recoveryDigest(existing.value) !== recoveryDigest(value))
        throw new Error("V2 installation identity archive conflicts; evidence preserved.");
      if (!existing)
        await archive.replace(archiveKey, undefined, value, {
          signal: authority.signal,
          assertCurrent,
        });
      await verify();
      return records.replace(key, signed.revision, revalidated, {
        signal: authority.signal,
        assertCurrent,
      });
    },
  };
}
