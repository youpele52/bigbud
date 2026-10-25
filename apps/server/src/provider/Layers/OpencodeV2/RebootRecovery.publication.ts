import { createHash } from "node:crypto";
import path from "node:path";
import * as Schema from "effect/Schema";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import { readV2ThreadPrivateFile } from "./Orchestration.storage.ts";
import { readV2RebootProof } from "./RebootRecovery.proof.ts";
import { readV2RecoveryHost } from "./RebootRecovery.host.ts";
import { recoveryDigest } from "./RebootRecovery.schema.ts";
import { recoveryOwner } from "./RebootRecovery.evidence.ts";
import {
  V2PluginPublication,
  v2PublicationFilename,
  type V2PluginSetupArtifact,
} from "./PluginSetup.record.ts";
import {
  readV2NativePluginFile,
  v2NativePluginDirectory,
  type V2PluginFileIdentity,
} from "./PluginSetup.fs.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import { assertV2PluginUpgradeIdle } from "./PluginSetup.upgrade.ts";
import { revalidateV2InstallationIdentity } from "./PluginSetup.revalidation.identity.ts";

/** A prepared, sealed reboot can revalidate a committed signed entry after st_dev renumbering.
 * This is explicit maintenance adoption, not proof that a device number is a persistent volume ID.
 * Normal publications still require exact dev+ino; the original signed identity is archived unchanged. */
export async function recoverV2RebootPublication(
  records: V2ThreadRecords,
  key: string,
  signed: NonNullable<Awaited<ReturnType<V2ThreadRecords["read"]>>>,
  artifact: V2PluginSetupArtifact,
  root: string,
  rootIdentity: V2PluginFileIdentity,
) {
  const old = Schema.decodeUnknownSync(V2PluginPublication)(signed.value, {
    onExcessProperty: "error",
  });
  const proof = await readV2RebootProof(records),
    host = await readV2RecoveryHost();
  if (
    !proof ||
    host.bootSession !== proof.seal.host.bootSession ||
    proof.checkpoint.issuer !== artifact.issuer ||
    old.next.issuer !== artifact.issuer ||
    old.root !== root ||
    key !== JSON.stringify([root, v2PublicationFilename(old)]) ||
    old.phase !== "committed" ||
    !old.nextIdentity ||
    proof.checkpoint.owners.some((entry) => {
      const { owner } = recoveryOwner(entry);
      return (
        owner.protocol !== "bigbud.thread.v1" || owner.artifactDigest !== old.next.artifactDigest
      );
    })
  )
    throw new Error(
      "V2 reboot publication requires the exact sealed legacy installation and current recovery boot.",
    );
  const filename = path.join(root, "plugins", v2PublicationFilename(old));
  const name = createHash("sha256").update(key).digest("hex");
  const archived = JSON.parse(
    await readV2ThreadPrivateFile(
      path.join(proof.checkpoint.backup.directory, "installations", name),
    ),
  );
  if (recoveryDigest(archived) !== recoveryDigest(signed))
    throw new Error("V2 reboot publication original signed backup changed; no identity adoption.");
  const record = await revalidateV2InstallationIdentity(old, root, rootIdentity);
  const auditKey = `publication-reboot:${recoveryDigest(signed)}`;
  const audit = {
    format: "bigbud.thread.reboot-publication.v1",
    checkpointDigest: proof.digest,
    host,
    archivedSignedInstallation: signed,
    revalidated: record,
  };
  return {
    record,
    /** Called only after normal idle/admission closure. Archive before replacing any installation evidence. */
    archive: async (authority: V2PluginSetupAuthority) => {
      const assertCurrent = () => {
        authority.assertCurrent();
        authority.signal.throwIfAborted();
        if (!authority.publication)
          throw new Error("V2 reboot publication requires the normal closed activation gate.");
        authority.publication.assertGate();
      };
      assertCurrent();
      await assertV2PluginUpgradeIdle(artifact);
      await v2NativePluginDirectory(root, rootIdentity);
      await v2NativePluginDirectory(path.join(root, "plugins"), record.pluginsIdentity);
      const current = await readV2NativePluginFile(filename, true, 16384);
      if (
        current?.content !== record.next.content ||
        current.identity.dev !== record.nextIdentity.dev ||
        current.identity.ino !== record.nextIdentity.ino ||
        recoveryDigest(await records.read(key)) !== recoveryDigest(signed)
      )
        throw new Error("V2 reboot publication successor preserved before identity adoption.");
      const existing = await proof.store.read(auditKey);
      assertCurrent();
      if (existing) {
        if (recoveryDigest(existing.value) !== recoveryDigest(audit))
          throw new Error("V2 reboot publication audit conflicts with prior evidence.");
      } else
        await proof.store.replace(auditKey, undefined, audit, {
          signal: authority.signal,
          assertCurrent,
        });
      assertCurrent();
    },
  };
}
