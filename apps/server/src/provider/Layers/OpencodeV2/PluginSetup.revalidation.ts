import path from "node:path";
import { createHash } from "node:crypto";
import * as Schema from "effect/Schema";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import { readV2ThreadPrivateFile } from "./Orchestration.storage.ts";
import { readV2RebootProof } from "./RebootRecovery.proof.ts";
import { assertV2RebootBoundary, readV2RecoveryHost } from "./RebootRecovery.host.ts";
import { recoveryDigest } from "./RebootRecovery.schema.ts";
import {
  V2PluginPublication,
  V2_MANAGED_PLUGIN_FILENAME,
  v2PublicationFilename,
  v2ManagedPluginEntry,
} from "./PluginSetup.record.ts";
import { v2NativePluginDirectory } from "./PluginSetup.fs.ts";
import { revalidateV2InstallationIdentity } from "./PluginSetup.revalidation.identity.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import type { V2PluginSetupArtifact } from "./PluginSetup.record.ts";
import { assertV2PluginUpgradeIdle } from "./PluginSetup.upgrade.ts";
import { recoverV2RebootPublication } from "./RebootRecovery.publication.ts";

type Signed = NonNullable<Awaited<ReturnType<V2ThreadRecords["read"]>>>;
const approvalKey = (signed: Signed, bootSession: string) =>
  `publication-revalidation:${recoveryDigest(signed)}:${bootSession}`;

/** Explicit adoption checks: device numbers may change, but neither canonical object nor bytes may. */
async function observe(
  records: V2ThreadRecords,
  key: string,
  signed: Signed,
  root: string,
  issuer: string,
) {
  const old = Schema.decodeUnknownSync(V2PluginPublication)(signed.value, {
    onExcessProperty: "error",
  });
  const proof = await readV2RebootProof(records),
    host = await readV2RecoveryHost();
  if (!proof || proof.checkpoint.issuer !== issuer)
    throw new Error(
      "V2 installation revalidation requires existing signed same-host reboot evidence.",
    );
  assertV2RebootBoundary(proof.seal.host, host);
  const rootIdentity = await v2NativePluginDirectory(root);
  if (
    old.root !== root ||
    key !== JSON.stringify([root, v2PublicationFilename(old)]) ||
    old.next.issuer !== issuer ||
    old.phase !== "committed" ||
    !old.nextIdentity
  )
    throw new Error(
      "V2 installation revalidation requires exact signed bytes, unchanged inodes, and one device transition.",
    );
  return {
    format: "bigbud.thread.installation-revalidation.v1",
    checkpointDigest: proof.digest,
    host,
    archivedSignedInstallation: signed,
    revalidated: await revalidateV2InstallationIdentity(old, root, rootIdentity),
  };
}

/** Preparation archives evidence only; normal Settings consent and closed idle admission still apply. */
export async function prepareV2InstallationRevalidation(
  records: V2ThreadRecords,
  root: string,
  issuer: string,
  backup: { directory: string; databaseDigest: string },
  assertCurrent: () => void,
  filename = V2_MANAGED_PLUGIN_FILENAME,
) {
  const key = JSON.stringify([root, filename]);
  const signed = await records.read(key);
  if (!signed)
    throw new Error("V2 installation revalidation requires an existing signed installation.");
  const name = createHash("sha256").update(key).digest("hex");
  const archived = JSON.parse(
    await readV2ThreadPrivateFile(path.join(backup.directory, "installations", name)),
  );
  if (recoveryDigest(archived) !== recoveryDigest(signed))
    throw new Error("V2 installation revalidation backup differs from the signed installation.");
  const approval = { ...(await observe(records, key, signed, root, issuer)), backup };
  if (
    (await readV2ThreadPrivateFile(
      path.join(backup.directory, v2PublicationFilename(approval.revalidated)),
    )) !== approval.revalidated.next.content
  )
    throw new Error("V2 installation revalidation managed-byte backup changed.");
  const store = await records.sibling("recovery"),
    nameKey = approvalKey(signed, approval.host.bootSession);
  const prior = await store.read(nameKey);
  assertCurrent();
  if (recoveryDigest(await records.read(key)) !== recoveryDigest(signed))
    throw new Error("V2 installation revalidation successor preserved.");
  if (prior && recoveryDigest(prior.value) !== recoveryDigest(approval))
    throw new Error("V2 installation revalidation approval conflicts with retained evidence.");
  if (!prior)
    await store.replace(nameKey, undefined, approval, {
      assertCurrent,
      signal: new AbortController().signal,
    });
}

/** An approval is exact-installation and exact-boot scoped, never permission to adopt a successor. */
export async function recoverV2InstallationRevalidation(
  records: V2ThreadRecords,
  key: string,
  signed: Signed,
  artifact: V2PluginSetupArtifact,
  root: string,
) {
  const proof = await readV2RebootProof(records),
    host = await readV2RecoveryHost();
  if (proof?.seal.host.bootSession === host.bootSession) {
    const legacy = await recoverV2RebootPublication(
      records,
      key,
      signed,
      artifact,
      root,
      await v2NativePluginDirectory(root),
    );
    return {
      record: legacy.record,
      archive: async (authority: V2PluginSetupAuthority) => {
        await legacy.archive(authority);
        await authority.publication!.beforeMutation();
        await legacy.archive(authority);
        return records.replace(key, signed.revision, legacy.record, {
          signal: authority.signal,
          assertCurrent: () => {
            authority.assertCurrent();
            authority.signal.throwIfAborted();
            authority.publication!.assertGate();
          },
        });
      },
    };
  }
  const observed = await observe(records, key, signed, root, artifact.issuer);
  const store = await records.sibling("recovery"),
    approval = await store.read(approvalKey(signed, observed.host.bootSession));
  const value = approval?.value as { backup?: unknown } | undefined;
  if (
    !approval ||
    recoveryDigest(approval.value) !== recoveryDigest({ ...observed, backup: value?.backup })
  )
    throw new Error(
      "V2 installation identity changed after reboot; prepare explicit backed-up installation revalidation before retrying Settings setup. Evidence retained.",
    );
  const apply = async (authority: V2PluginSetupAuthority, requireRetirement: boolean) => {
    const assertCurrent = () => {
      authority.assertCurrent();
      authority.signal.throwIfAborted();
      if (!authority.publication)
        throw new Error("V2 installation revalidation requires closed activation admission.");
      authority.publication.assertGate();
    };
    assertCurrent();
    if (requireRetirement) await assertV2PluginUpgradeIdle(artifact);
    if (
      recoveryDigest(await observe(records, key, signed, root, artifact.issuer)) !==
        recoveryDigest(observed) ||
      recoveryDigest(await store.read(approvalKey(signed, observed.host.bootSession))) !==
        recoveryDigest(approval)
    )
      throw new Error("V2 installation revalidation authority changed; evidence retained.");
    await authority.publication!.beforeMutation();
    assertCurrent();
    if (
      recoveryDigest(await observe(records, key, signed, root, artifact.issuer)) !==
      recoveryDigest(observed)
    )
      throw new Error("V2 installation revalidation native successor preserved.");
    // The signed approval already durably archives the original before conditional replacement.
    return records.replace(key, signed.revision, observed.revalidated, {
      signal: authority.signal,
      assertCurrent,
    });
  };
  const wanted = v2ManagedPluginEntry(artifact, root);
  return {
    record: observed.revalidated,
    archive: (authority: V2PluginSetupAuthority) => apply(authority, true),
    ...(observed.revalidated.next.content === wanted.content &&
    observed.revalidated.next.hash === wanted.hash &&
    observed.revalidated.next.artifactDigest === artifact.artifactDigest
      ? { applyIdentityOnly: (authority: V2PluginSetupAuthority) => apply(authority, false) }
      : {}),
  };
}
