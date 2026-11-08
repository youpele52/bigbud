import { expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { makeV2RetainedActivationFixture } from "./PluginSetup.activation.retained.fixture.ts";
import { recoverV2LockedInstallationIdentity } from "./PluginSetup.revalidation.locked.ts";
import type { V2PluginSetupAuthority } from "./PluginSetup.paths.ts";
import { readV2RebootCheckpoint, readV2RebootProof } from "./RebootRecovery.proof.ts";
import { recoverV2RebootForSetup } from "./RebootRecovery.setup.ts";

vi.mock("./SharedService.connection.ts", () => ({
  borrowV2SharedService: async () => {
    throw new Error("No native service");
  },
}));

it.each([
  "success",
  "no-authority",
  "authority-revoked",
  "changed-inode",
  "changed-bytes",
  "changed-after-prepare",
  "cancelled",
])("unchanged metadata maintenance without historical reboot proof: %s", async (scenario) => {
  const f = await makeV2RetainedActivationFixture();
  try {
    const dev = Number(f.publication.rootIdentity.dev) + 1;
    await f.installations.replace(f.key, (await f.installations.read(f.key))!.revision, {
      ...f.publication,
      rootIdentity: {
        ...f.publication.rootIdentity,
        dev,
        ...(scenario === "changed-inode"
          ? { ino: Number(f.publication.rootIdentity.ino) + 1 }
          : {}),
      },
      pluginsIdentity: { ...f.publication.pluginsIdentity, dev },
      nextIdentity: { ...f.publication.nextIdentity, dev },
    });
    const signed = (await f.installations.read(f.key))!;
    const before = await f.enrollments.inventory();
    if (scenario === "changed-bytes")
      await writeFile(f.filename, `${f.entry.content}\n`, { mode: 0o600 });
    const controller = new AbortController();
    const authority: V2PluginSetupAuthority = {
      signal: controller.signal,
      assertCurrent: () => controller.signal.throwIfAborted(),
      publication: {
        prepare: async () => {},
        locked: async () => () => {},
        beforeMutation: async () => {},
        assertGate: () => {},
        joinPhysicalOnCancel: true,
        ...(scenario === "no-authority"
          ? {}
          : {
              assertInstallationOwner: async () => {
                if (scenario === "authority-revoked") throw new Error("lock lost");
              },
            }),
      },
    };
    const run = async () => {
      const candidate = await recoverV2LockedInstallationIdentity(
        f.installations,
        f.key,
        signed,
        f.installed,
        f.root,
      );
      if (scenario === "cancelled") controller.abort();
      if (scenario === "changed-after-prepare")
        await writeFile(f.filename, `${f.entry.content}\n`, { mode: 0o600 });
      return candidate.applyIdentityOnly(authority);
    };
    if (scenario === "success") {
      await run();
      const current = (await f.installations.read(f.key))!.value;
      expect(current).toEqual(f.publication);
      const archives = await (await f.installations.sibling("recovery")).entries();
      expect(archives).toHaveLength(1);
      expect(archives[0]!.value).toMatchObject({
        format: "bigbud.thread.locked-installation-identity.v1",
        archivedSignedInstallation: signed,
      });
      expect(await readFile(f.filename, "utf8")).toBe(f.entry.content);
      // Restart/setup must not mistake an installation-only archive for a partial reboot.
      await expect(readV2RebootCheckpoint(f.enrollments)).resolves.toBeUndefined();
      await expect(readV2RebootProof(f.enrollments)).resolves.toBeUndefined();
      await expect(
        recoverV2RebootForSetup({
          artifact: f.app.artifact,
          activation: f.coordinator,
          descriptor: f.descriptor,
          client: f.client,
          sql: undefined,
          signal: controller.signal,
        }),
      ).resolves.toBeUndefined();
      expect(await (await f.installations.sibling("recovery")).entries()).toEqual(archives);
    } else {
      await expect(run()).rejects.toThrow();
      expect(await f.installations.read(f.key)).toEqual(signed);
    }
    expect(await f.enrollments.inventory()).toEqual(before);
    expect(f.rpc).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});
