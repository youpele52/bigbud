import * as Schema from "effect/Schema";
import type { V2ThreadRecords } from "./Orchestration.records.ts";
import {
  V2PluginPublication,
  v2ManagedPluginEntry,
  type V2PluginSetupArtifact,
} from "./PluginSetup.record.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import type { V2PluginFileIdentity } from "./PluginSetup.fs.ts";
import { recoverV2InstallationRevalidation } from "./PluginSetup.revalidation.ts";
import { closeV2PublicationBoundary } from "./PluginSetup.publication.boundary.ts";

/** Metadata-only admission: no native write, owner retirement, epoch change or history authority. */
export async function revalidateV2UnchangedPublication(
  artifact: V2PluginSetupArtifact,
  root: string,
  rootIdentity: V2PluginFileIdentity,
  authority: V2PluginSetupAuthority,
  records: V2ThreadRecords,
  key: string,
  signed: Awaited<ReturnType<V2ThreadRecords["read"]>>,
) {
  const publication = authority.publication?.identityRevalidation;
  if (!publication || !signed) return false;
  const old = Schema.decodeUnknownSync(V2PluginPublication)(signed.value, {
    onExcessProperty: "error",
  });
  const wanted = v2ManagedPluginEntry(artifact, root);
  if (
    old.phase !== "committed" ||
    old.next.hash !== wanted.hash ||
    old.next.content !== wanted.content ||
    old.next.artifactDigest !== artifact.artifactDigest ||
    typeof old.rootIdentity.dev !== "number" ||
    typeof rootIdentity.dev !== "number" ||
    old.rootIdentity.dev === rootIdentity.dev
  )
    return false;
  const candidate = await recoverV2InstallationRevalidation(records, key, signed, artifact, root);
  if (!("applyIdentityOnly" in candidate) || !candidate.applyIdentityOnly) return false;
  const owned: V2PluginSetupAuthority = {
    ...authority,
    publication,
    assertCurrent: () => {
      authority.assertCurrent();
      publication.assertGate();
    },
  };
  await publication.prepare();
  const release = await closeV2PublicationBoundary(artifact, root, owned);
  try {
    const operation = candidate.applyIdentityOnly(owned);
    publication.observePhysical?.(operation);
    const revision = await operation;
    if ((await records.read(key))?.revision !== revision)
      throw new Error("V2 installation revalidation successor preserved after metadata adoption.");
    owned.assertCurrent();
    owned.signal.throwIfAborted();
  } finally {
    await release();
  }
  return true;
}
