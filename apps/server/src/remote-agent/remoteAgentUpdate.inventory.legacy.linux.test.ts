import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildRemoteAgentInventoryCommand,
  parseRemoteAgentInventory,
} from "./remoteAgentUpdate.inventory.ts";
import {
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

const legacyDigest = createHash("sha256").update("legacy").digest("hex");
const managedDigest = createHash("sha256").update("managed").digest("hex");

describe.runIf(linuxControlAvailable)("Linux legacy remote agent inventory", () => {
  it("counts an installed legacy binary and its aliases once without claiming ownership", async () => {
    const fixture = createLinuxControlFixture();
    try {
      const root = fixture.root;
      const legacy = `${root}/bin/0.2.205/bigbud-remote-agent`;
      const managed = `${root}/bin/0.2.209/${managedDigest}/bigbud-remote-agent`;
      await fixture.run(`umask 077
mkdir -p -m 700 '${root}/bin/0.2.205' '${root}/bin/0.2.209/${managedDigest}'
printf legacy > '${legacy}'
printf managed > '${managed}'
chmod 700 '${legacy}' '${managed}'
ln -s '${legacy}' '${root}/bin/current'
ln -s '${legacy}' '${root}/bin/previous'
ln -s current '${root}/bin/legacy-alias'
`);
      const inventory = parseRemoteAgentInventory(
        await fixture.run(buildRemoteAgentInventoryCommand(root)),
      );
      expect(inventory.uniqueDigests).toEqual(new Set([legacyDigest, managedDigest]));
      expect(
        inventory.entries
          .filter((entry) => entry.digest === legacyDigest)
          .every((entry) => entry.kind === "legacy"),
      ).toBe(true);
      expect(inventory.unknownOwner).toBe(true);
      expect(inventory.untracked).toBe(false);
      expect(inventory.noncompliant).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it.each(["unexpected-file", "unsafe-version", "extra-depth", "symlink-parent"])(
    "keeps %s unsafe even when a current alias points into bin",
    async (kind) => {
      const fixture = createLinuxControlFixture();
      try {
        const root = fixture.root;
        await fixture.run(`umask 077; mkdir -p -m 700 '${root}/bin' '${root}/outside'`);
        const target =
          kind === "unexpected-file"
            ? `${root}/bin/0.2.205/unexpected`
            : kind === "unsafe-version"
              ? `${root}/bin/bad version/bigbud-remote-agent`
              : kind === "extra-depth"
                ? `${root}/bin/0.2.205/${managedDigest}/extra/bigbud-remote-agent`
                : `${root}/bin/0.2.205/bigbud-remote-agent`;
        if (kind === "symlink-parent") {
          await fixture.run(
            `printf legacy > '${root}/outside/bigbud-remote-agent'; chmod 700 '${root}/outside/bigbud-remote-agent'; ln -s '${root}/outside' '${root}/bin/0.2.205'`,
          );
        } else {
          await fixture.run(
            `mkdir -p -m 700 "$(dirname '${target}')"; printf legacy > '${target}'; chmod 700 '${target}'`,
          );
        }
        await fixture.run(`ln -s '${target}' '${root}/bin/current'`);
        const inventory = parseRemoteAgentInventory(
          await fixture.run(buildRemoteAgentInventoryCommand(root)),
        );
        expect(inventory.noncompliant).toBe(true);
        expect(inventory.untracked).toBe(true);
      } finally {
        fixture.close();
      }
    },
  );
});
