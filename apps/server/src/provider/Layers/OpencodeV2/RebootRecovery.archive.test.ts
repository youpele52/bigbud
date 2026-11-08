import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { makeV2RetainedActivationFixture } from "./PluginSetup.activation.retained.fixture.ts";
import { v2LockedInstallationArchiveKey } from "./PluginSetup.revalidation.archive.ts";
import { readV2RebootCheckpoint, readV2RebootProof } from "./RebootRecovery.proof.ts";
import { checkpointKey, settlementKey } from "./RebootRecovery.schema.ts";

it.each([
  "valid",
  "empty",
  "unknown-record",
  "wrong-key",
  "invalid-nested-signature",
  "changed-inode",
  "extra-field",
  "orphan-seal",
  "archive-as-checkpoint",
  "partial-file",
])("optional reboot inspection distinguishes installation-only archives: %s", async (scenario) => {
  const f = await makeV2RetainedActivationFixture();
  try {
    const dev = Number(f.publication.rootIdentity.dev) + 1;
    await f.installations.replace(f.key, (await f.installations.read(f.key))!.revision, {
      ...f.publication,
      rootIdentity: { ...f.publication.rootIdentity, dev },
      pluginsIdentity: { ...f.publication.pluginsIdentity, dev },
      nextIdentity: { ...f.publication.nextIdentity, dev },
    });
    const signed = (await f.installations.read(f.key))!;
    const value = {
      format: "bigbud.thread.locked-installation-identity.v1",
      archivedSignedInstallation:
        scenario === "invalid-nested-signature" ? { ...signed, signature: "A".repeat(86) } : signed,
      revalidated:
        scenario === "changed-inode"
          ? {
              ...f.publication,
              rootIdentity: {
                ...f.publication.rootIdentity,
                ino: Number(f.publication.rootIdentity.ino) + 1,
              },
            }
          : f.publication,
      ...(scenario === "extra-field" ? { unexpected: true } : {}),
    };
    const store = await f.enrollments.sibling("recovery");
    if (scenario !== "empty")
      await store.replace(
        scenario === "archive-as-checkpoint"
          ? checkpointKey
          : scenario === "wrong-key"
            ? "unrelated-key"
            : v2LockedInstallationArchiveKey(signed),
        undefined,
        value,
      );
    if (scenario === "unknown-record")
      await store.replace("unknown", undefined, { format: "future.evidence.v1" });
    if (scenario === "orphan-seal")
      await store.replace(settlementKey, undefined, {
        format: "bigbud.thread.reboot-settlement.v1",
      });
    if (scenario === "partial-file")
      await writeFile(path.join(store.directory, "partial"), "evidence", { mode: 0o600 });
    const owners = await f.enrollments.inventory();
    const inspect = () => readV2RebootCheckpoint(f.enrollments);
    if (scenario === "valid") {
      const before = await store.inventory();
      await expect(inspect()).resolves.toBeUndefined();
      await expect(readV2RebootProof(f.enrollments)).resolves.toBeUndefined();
      expect(await store.inventory()).toEqual(before);
    } else {
      await expect(inspect()).rejects.toThrow();
      await expect(readV2RebootProof(f.enrollments)).rejects.toThrow();
    }
    expect(await f.enrollments.inventory()).toEqual(owners);
    expect(f.rpc).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
