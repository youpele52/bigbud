import type { V2ThreadRecords } from "./Orchestration.records.ts";
import { v2ManagedPluginEntry, type V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import { observeV2InstallationRevalidation } from "./PluginSetup.revalidation.ts";
import { assertV2RebootBoundary, type V2RecoveryHost } from "./RebootRecovery.host.ts";
import { recoveryDigest } from "./RebootRecovery.schema.ts";

/** Same-artifact metadata adoption uses existing reboot evidence, never per-boot manual consent. */
export async function recoverV2AutomaticInstallationIdentity(
  records: V2ThreadRecords,
  key: string,
  signed: NonNullable<Awaited<ReturnType<V2ThreadRecords["read"]>>>,
  artifact: V2PluginSetupArtifact,
  root: string,
) {
  const observed = await observeV2InstallationRevalidation(
    records,
    key,
    signed,
    root,
    artifact.issuer,
  );
  const wanted = v2ManagedPluginEntry(artifact, root);
  if (
    observed.revalidated.next.content !== wanted.content ||
    observed.revalidated.next.hash !== wanted.hash ||
    observed.revalidated.next.artifactDigest !== artifact.artifactDigest
  )
    throw new Error("V2 automatic identity recovery cannot change the installed artifact.");
  const store = await records.sibling("recovery");
  const auditKey = `publication-automatic-revalidation:${recoveryDigest(signed)}:${observed.host.bootSession}`;
  const audit = { ...observed, format: "bigbud.thread.automatic-installation-revalidation.v1" };
  // An older seal must not authorize a second device transition in the same boot.
  // Include manual adoption evidence so switching policies does not weaken that boundary.
  const assertPriorBoot = async () => {
    for (const entry of await store.inventory()) {
      const value = entry.signed.value as {
        format?: string;
        revalidated?: unknown;
        host?: V2RecoveryHost;
      };
      if (
        [
          "bigbud.thread.automatic-installation-revalidation.v1",
          "bigbud.thread.installation-revalidation.v1",
          "bigbud.thread.reboot-publication.v1",
        ].includes(value.format ?? "") &&
        recoveryDigest(value.revalidated) === recoveryDigest(signed.value)
      ) {
        if (!value.host)
          throw new Error("V2 installation revalidation boot evidence is incomplete.");
        assertV2RebootBoundary(value.host, observed.host);
      }
    }
  };
  await assertPriorBoot();
  return {
    applyIdentityOnly: async (authority: V2PluginSetupAuthority) => {
      const assertCurrent = () => {
        authority.assertCurrent();
        authority.signal.throwIfAborted();
        if (!authority.publication)
          throw new Error("V2 automatic identity recovery requires closed activation admission.");
        authority.publication.assertGate();
      };
      const recheck = async () => {
        assertCurrent();
        await assertPriorBoot();
        if (
          recoveryDigest(await records.read(key)) !== recoveryDigest(signed) ||
          recoveryDigest(
            await observeV2InstallationRevalidation(records, key, signed, root, artifact.issuer),
          ) !== recoveryDigest(observed)
        )
          throw new Error("V2 automatic installation revalidation successor preserved.");
        assertCurrent();
      };
      await recheck();
      await authority.publication!.beforeMutation();
      await recheck();
      const existing = await store.read(auditKey);
      if (existing && recoveryDigest(existing.value) !== recoveryDigest(audit))
        throw new Error(
          "V2 automatic installation revalidation audit conflicts with retained evidence.",
        );
      if (!existing)
        await store.replace(auditKey, undefined, audit, {
          signal: authority.signal,
          assertCurrent,
        });
      // Archive the original signed record durably before CAS; a crash remains retryable.
      await recheck();
      return records.replace(key, signed.revision, observed.revalidated, {
        signal: authority.signal,
        assertCurrent,
      });
    },
  };
}
