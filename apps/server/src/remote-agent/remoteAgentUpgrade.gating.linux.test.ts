import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildRemoteAgentInventoryCommand,
  parseRemoteAgentInventory,
} from "./remoteAgentUpdate.inventory.ts";
import {
  countPhysicalRemoteAgentExecutables,
  createLinuxControlFixture,
  linuxFixtureAvailability,
  linuxFixtureName,
  type LinuxFixtureArchitecture,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

const architectures: ReadonlyArray<LinuxFixtureArchitecture> = ["aarch64", "x86_64"];

for (const architecture of architectures) {
  const gate = linuxFixtureAvailability(architecture, ["legacy", "candidate"]);
  describe.runIf(gate.available)(
    `Linux fixture acceptance: ${architecture}${gate.available ? "" : ` (skipped: ${gate.reason})`}`,
    () => {
      let fixture: ReturnType<typeof createLinuxControlFixture>;
      let root: string;

      beforeEach(async () => {
        fixture = createLinuxControlFixture();
        root = fixture.root;
        await fixture.run(`mkdir -p -m 700 '${root}/bin'`);
      });
      afterEach(() => fixture?.close());

      it("labels provenance and counts physical executables at every update boundary", async ({
        skip,
      }) => {
        const containerArchitecture = (await fixture.run("uname -m")).trim();
        if (containerArchitecture !== architecture) {
          skip(`matching ${architecture} container is unavailable (got ${containerArchitecture})`);
          return;
        }
        expect(gate.provenance).toBe("source-built");
        expect(gate.artifactTrust).toBe("not-published");
        expect(await countPhysicalRemoteAgentExecutables(fixture, root)).toBe(0);
        expect(
          parseRemoteAgentInventory(await fixture.run(buildRemoteAgentInventoryCommand(root)))
            .uniqueDigests,
        ).toEqual(new Set());

        const legacy = linuxFixtureName("legacy", architecture);
        const candidate = linuxFixtureName("candidate", architecture);
        const legacyDigest = (
          await fixture.run(`sha256sum '/fixtures/${legacy}' | cut -d ' ' -f1`)
        ).trim();
        const candidateDigest = (
          await fixture.run(`sha256sum '/fixtures/${candidate}' | cut -d ' ' -f1`)
        ).trim();
        expect(await fixture.run(`/fixtures/${legacy} --check`)).toMatch(
          new RegExp(`linux\\s+${architecture}`),
        );
        expect(await fixture.run(`/fixtures/${candidate} --check`)).toMatch(
          new RegExp(`linux\\s+${architecture}`),
        );

        await fixture.run(
          `mkdir -p -m 700 '${root}/bin/0.2.207/${candidateDigest}' '${root}/staging'; cp '/fixtures/${candidate}' '${root}/staging/candidate.payload'; chmod 700 '${root}/staging/candidate.payload'`,
        );
        expect(await countPhysicalRemoteAgentExecutables(fixture, root)).toBe(0);
        const staged = parseRemoteAgentInventory(
          await fixture.run(buildRemoteAgentInventoryCommand(root)),
        );
        expect(staged.partialCandidate).toBe(true);
        expect(staged.uniqueDigests).toEqual(new Set([candidateDigest]));

        await fixture.run(
          `cp '/fixtures/${candidate}' '${root}/bin/0.2.207/${candidateDigest}/bigbud-remote-agent'; chmod 700 '${root}/bin/0.2.207/${candidateDigest}/bigbud-remote-agent'`,
        );
        expect(await countPhysicalRemoteAgentExecutables(fixture, root)).toBe(1);
        expect(
          parseRemoteAgentInventory(await fixture.run(buildRemoteAgentInventoryCommand(root)))
            .uniqueDigests,
        ).toEqual(new Set([candidateDigest]));

        await fixture.run(
          `printf '%s\\n' '#!/bin/sh' 'exit 1' > '${root}/staging/health-failure'; chmod 700 '${root}/staging/health-failure'`,
        );
        expect(
          await fixture.run(
            `if '${root}/staging/health-failure'; then printf unexpected; else printf failed; fi`,
          ),
        ).toBe("failed");
        expect(await countPhysicalRemoteAgentExecutables(fixture, root)).toBe(1);
        const failedHealth = parseRemoteAgentInventory(
          await fixture.run(buildRemoteAgentInventoryCommand(root)),
        );
        expect(failedHealth.partialCandidate).toBe(true);
        expect(failedHealth.noncompliant).toBe(false);

        await fixture.run(
          `rm '${root}/staging/health-failure'; mkdir -p -m 700 '${root}/bin/0.2.205/${legacyDigest}'; cp '/fixtures/${legacy}' '${root}/bin/0.2.205/${legacyDigest}/bigbud-remote-agent'; chmod 700 '${root}/bin/0.2.205/${legacyDigest}/bigbud-remote-agent'; ln -s '${root}/bin/0.2.207/${candidateDigest}/bigbud-remote-agent' '${root}/bin/current'; ln -s '${root}/bin/0.2.205/${legacyDigest}/bigbud-remote-agent' '${root}/bin/previous'; ln -s '${root}/bin/0.2.207/${candidateDigest}/bigbud-remote-agent' '${root}/bin/candidate-alias'`,
        );
        expect(await countPhysicalRemoteAgentExecutables(fixture, root)).toBe(2);
        const promoted = parseRemoteAgentInventory(
          await fixture.run(buildRemoteAgentInventoryCommand(root)),
        );
        expect(promoted.uniqueDigests).toEqual(new Set([legacyDigest, candidateDigest]));
        expect(promoted.entries.some((entry) => entry.kind === "legacy")).toBe(false);
        expect(promoted.noncompliant).toBe(false);

        const externalDigest = (
          await fixture.run(
            "printf '%s' external-alias > /tmp/fixture-acceptance-external; chmod 700 /tmp/fixture-acceptance-external; sha256sum /tmp/fixture-acceptance-external | cut -d ' ' -f1",
          )
        ).trim();
        await fixture.run(`ln -s /tmp/fixture-acceptance-external '${root}/bin/untrusted-alias'`);
        const aliased = parseRemoteAgentInventory(
          await fixture.run(buildRemoteAgentInventoryCommand(root)),
        );
        expect(await countPhysicalRemoteAgentExecutables(fixture, root)).toBe(2);
        expect(aliased.uniqueDigests).toEqual(
          new Set([legacyDigest, candidateDigest, externalDigest]),
        );
        expect(aliased.unknownOwner).toBe(true);
        expect(aliased.noncompliant).toBe(true);

        await fixture.run("rm -f /tmp/fixture-acceptance-external");
        expect(await countPhysicalRemoteAgentExecutables(fixture, root)).toBe(2);
        await fixture.run(`rm '${root}/bin/0.2.205/${legacyDigest}/bigbud-remote-agent'`);
        expect(await countPhysicalRemoteAgentExecutables(fixture, root)).toBe(1);
      });
    },
  );
}
