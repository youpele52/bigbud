import path from "node:path";
import type { V2PluginSetupArtifact, V2PluginPublication } from "./PluginSetup.record.ts";
import { v2ManagedPluginFilename } from "./PluginSetup.record.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import { v2NativePluginDirectory } from "./PluginSetup.fs.ts";
import { revalidateV2InstallationIdentity } from "./PluginSetup.revalidation.identity.ts";
import { revalidateV2UnchangedPublication } from "./PluginSetup.revalidation.publication.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";

/** A fully checked device transition is a maintenance request, never readiness or write authority. */
export class V2RetainedInstallationIdentityChanged extends Error {
  constructor(readonly artifactDigest: string) {
    super(
      "V2 managed plugin filesystem device identity changed; normal setup must verify signed same-host reboot evidence before automatic metadata recovery. No permissions were changed.",
    );
    this.name = "V2RetainedInstallationIdentityChanged";
  }
}

/** Distinguish uniform device renumbering from unsafe or replaced native objects. */
export async function assertV2RetainedInstallationIdentity(
  record: V2PluginPublication,
  artifact: V2PluginSetupArtifact,
) {
  const root = await v2NativePluginDirectory(record.root);
  if (
    typeof root.dev === "number" &&
    typeof record.rootIdentity.dev === "number" &&
    root.dev !== record.rootIdentity.dev
  ) {
    await revalidateV2InstallationIdentity(record, record.root, root);
    throw new V2RetainedInstallationIdentityChanged(artifact.artifactDigest);
  }
  await v2NativePluginDirectory(record.root, record.rootIdentity);
  await v2NativePluginDirectory(path.join(record.root, "plugins"), record.pluginsIdentity);
}

/** Repair only approved signed metadata for the installed artifact, not preferred replacement bytes. */
export async function revalidateV2RetainedInstallation(
  changed: V2RetainedInstallationIdentityChanged,
  artifact: V2PluginSetupArtifact,
  root: string,
  authority: V2PluginSetupAuthority,
) {
  authority.assertCurrent();
  authority.signal.throwIfAborted();
  if (artifact.artifactDigest !== changed.artifactDigest) throw changed;
  const records = await V2ThreadRecords.open(
    artifact.root,
    "installations",
    artifact.privateKey,
    artifact.publicKey,
  );
  const key = JSON.stringify([root, v2ManagedPluginFilename(artifact)]);
  if (
    !(await revalidateV2UnchangedPublication(
      artifact,
      root,
      await v2NativePluginDirectory(root),
      authority,
      records,
      key,
      await records.read(key),
    ))
  )
    throw changed;
}
