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
      const targetTriple = `${root}/bin/0.2.205/target-triple`;
      const managed = `${root}/bin/0.2.209/${managedDigest}/bigbud-remote-agent`;
      await fixture.run(`umask 077
mkdir -p -m 700 '${root}/bin/0.2.205' '${root}/bin/0.2.209/${managedDigest}'
printf legacy > '${legacy}'
printf 'aarch64-unknown-linux-gnu\n' > '${targetTriple}'
printf managed > '${managed}'
chmod 700 '${legacy}' '${managed}'
chmod 600 '${targetTriple}'
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
      expect(inventory.entries).toContainEqual({
        digest: createHash("sha256").update("aarch64-unknown-linux-gnu\n").digest("hex"),
        path: targetTriple,
        kind: "metadata",
      });
    } finally {
      fixture.close();
    }
  });

  it.each([
    ["malformed contents", "not-a-target", "600"],
    ["missing trailing newline", "aarch64-unknown-linux-gnu", "600"],
    ["multiple trailing newlines", "aarch64-unknown-linux-gnu\\n\\n", "600"],
    ["unsafe permissions", "aarch64-unknown-linux-gnu\\n", "644"],
  ])("keeps target-triple metadata fail-closed with %s", async (_label, contents, mode) => {
    const fixture = createLinuxControlFixture();
    try {
      const root = fixture.root;
      const legacy = `${root}/bin/0.2.205/bigbud-remote-agent`;
      const targetTriple = `${root}/bin/0.2.205/target-triple`;
      await fixture.run(`umask 077
mkdir -p -m 700 '${root}/bin/0.2.205'
printf legacy > '${legacy}'
printf '${contents}' > '${targetTriple}'
chmod 700 '${legacy}'
chmod '${mode}' '${targetTriple}'
ln -s '${legacy}' '${root}/bin/current'
`);
      const inventory = parseRemoteAgentInventory(
        await fixture.run(buildRemoteAgentInventoryCommand(root)),
      );
      expect(inventory.entries).toContainEqual(
        expect.objectContaining({ path: targetTriple, kind: "unknown" }),
      );
      expect(inventory.untracked).toBe(true);
      expect(inventory.noncompliant).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it.each([
    ["nested path", "0.2.205/nested"],
    ["other version", "0.2.209"],
  ])("keeps target-triple metadata fail-closed at a %s", async (_label, directory) => {
    const fixture = createLinuxControlFixture();
    try {
      const root = fixture.root;
      const misplaced = `${root}/bin/${directory}/target-triple`;
      await fixture.run(`umask 077
mkdir -p -m 700 '${root}/bin/${directory}'
printf 'aarch64-unknown-linux-gnu\n' > '${misplaced}'
chmod 600 '${misplaced}'
`);
      const inventory = parseRemoteAgentInventory(
        await fixture.run(buildRemoteAgentInventoryCommand(root)),
      );
      expect(inventory.entries).toContainEqual(
        expect.objectContaining({ path: misplaced, kind: "unknown" }),
      );
      expect(inventory.untracked).toBe(true);
      expect(inventory.noncompliant).toBe(true);
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
