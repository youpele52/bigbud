import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";
import { makeRemoteAgentRegistryStore } from "./remoteAgentInstall.registry.store.ts";
import { inspectRemoteAgentInventory } from "./remoteAgentUpdate.inventory.ts";
import { reclaimUnregisteredRemoteAgentBuild } from "./remoteAgentInstall.orphan.ts";

describe.runIf(linuxControlAvailable)("unregistered managed build reclamation", () => {
  let fixture: ReturnType<typeof createLinuxControlFixture>;
  afterEach(() => fixture?.close());

  async function setup(linkOrphan = false) {
    fixture = createLinuxControlFixture();
    const root = fixture.root;
    const legacyBytes = "legacy";
    const orphanBytes = "managed-orphan";
    const orphanDigest = createHash("sha256").update(orphanBytes).digest("hex");
    const legacy = `${root}/bin/0.2.205/bigbud-remote-agent`;
    const orphan = `${root}/bin/0.2.207/${orphanDigest}/bigbud-remote-agent`;
    await fixture.run(`umask 077
mkdir -p -m 700 '${root}/bin/0.2.205' '${root}/bin/0.2.207/${orphanDigest}' '${root}/control-v1'
printf '${legacyBytes}' > '${legacy}'
printf 'x86_64-unknown-linux-gnu\n' > '${root}/bin/0.2.205/target-triple'
printf '${orphanBytes}' > '${orphan}'
chmod 700 '${legacy}' '${orphan}'
chmod 600 '${root}/bin/0.2.205/target-triple'
ln -s '${linkOrphan ? orphan : legacy}' '${root}/bin/current'
ln -s '${legacy}' '${root}/bin/previous'
`);
    return {
      root,
      orphan,
      orphanDigest,
      legacy,
      control: {
        root,
        run: fixture.run,
        registry: makeRemoteAgentRegistryStore(root, fixture),
      },
    };
  }

  it("reclaims the exact unreferenced payload left outside the registry", async () => {
    const current = await setup();
    const inventory = await inspectRemoteAgentInventory(current.control);

    await expect(
      reclaimUnregisteredRemoteAgentBuild({
        control: current.control,
        inventory,
        referencedBuildIds: async () => new Set(),
      }),
    ).resolves.toBe(true);

    expect(await fixture.run(`test ! -e '${current.orphan}' && printf reclaimed`)).toBe(
      "reclaimed",
    );
    expect(await fixture.run(`test -x '${current.legacy}' && printf retained`)).toBe("retained");
  });

  it.each(["durable owner", "active link"])("retains an orphan with a %s", async (reason) => {
    const current = await setup(reason === "active link");
    const inventory = await inspectRemoteAgentInventory(current.control);
    const referenced =
      reason === "durable owner"
        ? new Set([`0.2.207:${current.orphanDigest}:x86_64-unknown-linux-gnu`])
        : new Set<string>();

    await expect(
      reclaimUnregisteredRemoteAgentBuild({
        control: current.control,
        inventory,
        referencedBuildIds: async () => referenced,
      }),
    ).resolves.toBe(false);
    expect(await fixture.run(`test -x '${current.orphan}' && printf retained`)).toBe("retained");
  });
});
