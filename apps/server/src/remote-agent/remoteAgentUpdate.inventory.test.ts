import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRemoteAgentInventoryCommand,
  parseRemoteAgentInventory,
} from "./remoteAgentUpdate.inventory.ts";
import {
  countPhysicalRemoteAgentExecutables,
  createLinuxControlFixture,
  linuxControlAvailable,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

const first = "a".repeat(64);
const second = "b".repeat(64);

describe("remote agent physical inventory", () => {
  it("deduplicates hard-link or alias bytes and retains partial candidates", () => {
    const inventory = parseRemoteAgentInventory(
      [
        "remote-agent-inventory-v1",
        `file\t${first}\tmanaged\tL3RtcC9h`,
        `file\t${first}\tmanaged\tL3RtcC9i`,
        `file\t${second}\tstaging\tL3RtcC9j`,
        "unknown",
      ].join("\n"),
    );
    expect(inventory.uniqueDigests).toEqual(new Set([first, second]));
    expect(inventory.partialCandidate).toBe(true);
    expect(inventory.untracked).toBe(true);
    expect(inventory.noncompliant).toBe(true);
  });

  it("uses a private canonical root and exact hash output in the remote probe", () => {
    const command = buildRemoteAgentInventoryCommand("/home/test/.bigbud/agent");
    expect(command).toContain("remote-agent-inventory-v1");
    expect(command).toContain("sha256sum");
    expect(command).toContain("find -P");
    expect(command).toContain("MAX_SYMLINK_HOPS=32");
    expect(command).toContain('test ! -L "$bin"');
    expect(command).toContain('test ! -L "$staging"');
    expect(command).toContain("/home/test/.bigbud/agent");
    expect(() => buildRemoteAgentInventoryCommand("/tmp/unsafe path")).toThrow();
  });

  const linuxTest = linuxControlAvailable ? it : it.skip;
  const linuxSkipReason = linuxControlAvailable
    ? ""
    : ` (skipped: ${
        process.platform !== "linux"
          ? "Linux inventory commands require Linux or BIGBUD_TEST_LINUX_DOCKER=1 with Docker"
          : "Linux inventory tools are unavailable"
      })`;
  let fixture: ReturnType<typeof createLinuxControlFixture> | undefined;
  let protectedRoot: string | undefined;

  afterEach(async () => {
    try {
      await fixture?.run(
        "rm -f /tmp/remote-agent-inventory-external /tmp/remote-agent-inventory-directory/hidden; rmdir /tmp/remote-agent-inventory-directory 2>/dev/null || true",
      );
      if (protectedRoot)
        await fixture?.run(
          `rm -f '${protectedRoot}'; rmdir '${protectedRoot}-target' 2>/dev/null || true`,
        );
    } catch {
      // The fixture may already have stopped after a failed command.
    }
    fixture?.close();
    fixture = undefined;
    protectedRoot = undefined;
  });

  linuxTest(
    `rejects symlinked inventory roots and control directories${linuxSkipReason}`,
    async () => {
      fixture = createLinuxControlFixture();
      const root = fixture.root;
      const linkedRoot = `${root}-symlink`;
      protectedRoot = linkedRoot;
      await fixture.run(
        `mkdir -p -m 700 '${root}' '${root}-target'; ln -s '${root}-target' '${linkedRoot}'`,
      );
      await expect(fixture.run(buildRemoteAgentInventoryCommand(linkedRoot))).rejects.toThrow();

      await fixture.run(`ln -s /tmp '${root}/bin'`);
      await expect(fixture.run(buildRemoteAgentInventoryCommand(root))).rejects.toThrow();
      await fixture.run(`rm '${root}/bin'; ln -s /tmp '${root}/staging'`);
      await expect(fixture.run(buildRemoteAgentInventoryCommand(root))).rejects.toThrow();
    },
  );

  linuxTest(
    `resolves arbitrary aliases, blocks external and broken executables, and counts content${linuxSkipReason}`,
    async () => {
      fixture = createLinuxControlFixture();
      const root = fixture.root;
      const managedDigest = createHash("sha256").update("managed").digest("hex");
      const otherDigest = createHash("sha256").update("candidate").digest("hex");
      const externalDigest = createHash("sha256").update("external").digest("hex");
      await fixture.run(`
        umask 077
        mkdir -p -m 700 '${root}/bin/0.2.205/${managedDigest}' '${root}/bin/0.2.207/${otherDigest}' '${root}/staging' /tmp/remote-agent-inventory-directory
        printf '%s' managed > '${root}/bin/0.2.205/${managedDigest}/bigbud-remote-agent'
        printf '%s' candidate > '${root}/bin/0.2.207/${otherDigest}/bigbud-remote-agent'
        printf '%s' candidate > '${root}/staging/candidate.payload'
        printf '%s' external > /tmp/remote-agent-inventory-external
        printf '%s' hidden > /tmp/remote-agent-inventory-directory/hidden
        chmod 700 '${root}/bin/0.2.205/${managedDigest}/bigbud-remote-agent' '${root}/bin/0.2.207/${otherDigest}/bigbud-remote-agent' '${root}/staging/candidate.payload' /tmp/remote-agent-inventory-external
        ln -s '${root}/bin/0.2.207/${otherDigest}/bigbud-remote-agent' '${root}/bin/managed-alias'
        ln -s managed-alias '${root}/bin/managed-alias-chain'
        ln -s '${root}/staging/candidate.payload' '${root}/bin/staged-alias'
        ln -s /tmp/remote-agent-inventory-external '${root}/bin/external-alias'
        ln -s '${root}/bin/missing' '${root}/bin/broken-alias'
        ln -s /tmp/remote-agent-inventory-directory '${root}/bin/directory-alias'
        ln -s loop-b '${root}/bin/loop-a'
        ln -s loop-a '${root}/bin/loop-b'
        ln -s /tmp/remote-agent-inventory-external '${root}/bin/current'
        ln -s '${root}/bin/0.2.205/${managedDigest}/bigbud-remote-agent' '${root}/bin/previous'
        ln -s '${root}/staging/candidate.payload' '${root}/staging/staged-alias'
      `);

      const inventory = parseRemoteAgentInventory(
        await fixture.run(buildRemoteAgentInventoryCommand(root)),
      );
      expect(await countPhysicalRemoteAgentExecutables(fixture, root)).toBe(2);
      expect(inventory.uniqueDigests).toEqual(
        new Set([managedDigest, otherDigest, externalDigest]),
      );
      expect(inventory.entries).toContainEqual({
        digest: otherDigest,
        path: `${root}/bin/0.2.207/${otherDigest}/bigbud-remote-agent`,
        kind: "managed",
      });
      expect(inventory.entries).toContainEqual({
        digest: managedDigest,
        path: `${root}/bin/0.2.205/${managedDigest}/bigbud-remote-agent`,
        kind: "managed",
      });
      expect(inventory.entries).toContainEqual({
        digest: externalDigest,
        path: "/tmp/remote-agent-inventory-external",
        kind: "legacy",
      });
      expect(inventory.entries.some((entry) => entry.kind === "staging")).toBe(true);
      expect(inventory.entries.some((entry) => entry.kind === "unknown")).toBe(true);
      expect(inventory.entries.some((entry) => entry.path.endsWith("/hidden"))).toBe(false);
      expect(inventory.unknownOwner).toBe(true);
      expect(inventory.untracked).toBe(true);
      expect(inventory.uncertain).toBe(true);
      expect(inventory.noncompliant).toBe(true);
    },
  );
});
