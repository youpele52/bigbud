import { describe, expect, it } from "vitest";
import {
  buildRemoteAgentInventoryCommand,
  parseRemoteAgentInventory,
} from "./remoteAgentUpdate.inventory.ts";
import {
  createLinuxControlFixture,
  linuxFixtureAvailability,
  linuxFixtureName,
} from "./remoteAgentUpgrade.linux.fixtures.ts";

interface LinuxFixtureCase {
  readonly architecture: "aarch64" | "x86_64";
}

const fixtureCases: ReadonlyArray<LinuxFixtureCase> = [
  {
    architecture: "aarch64",
  },
  {
    architecture: "x86_64",
  },
];

describe("remote agent Linux acceptance inventory", () => {
  for (const fixtureCase of fixtureCases) {
    const gate = linuxFixtureAvailability(fixtureCase.architecture, ["legacy", "candidate"]);
    const test = gate.available ? it : it.skip;
    const status = gate.available ? "" : ` (skipped: ${gate.reason})`;
    test(`${fixtureCase.architecture} preserves legacy provenance and physical count${status}`, async ({
      skip,
    }) => {
      const fixture = createLinuxControlFixture();
      try {
        const containerArchitecture = (await fixture.run("uname -m")).trim();
        if (containerArchitecture !== fixtureCase.architecture) {
          skip(
            `matching ${fixtureCase.architecture} container is unavailable (got ${containerArchitecture})`,
          );
          return;
        }
        const root = fixture.root;
        const legacy = `/fixtures/${linuxFixtureName("legacy", fixtureCase.architecture)}`;
        const candidate = `/fixtures/${linuxFixtureName("candidate", fixtureCase.architecture)}`;
        await fixture.run(
          `umask 077; mkdir -p -m 700 '${root}/bin' '${root}/state'; ln -s '${legacy}' '${root}/bin/current'`,
        );

        const legacyDigest = (await fixture.run(`sha256sum '${legacy}' | cut -d ' ' -f1`)).trim();
        const initial = parseRemoteAgentInventory(
          await fixture.run(buildRemoteAgentInventoryCommand(root)),
        );
        expect(initial.entries).toContainEqual({
          digest: legacyDigest,
          path: legacy,
          kind: "legacy",
        });
        expect(initial.uniqueDigests).toEqual(new Set([legacyDigest]));
        expect(
          await fixture.run(`find -P '${root}/bin' -type f -name bigbud-remote-agent | wc -l`),
        ).toBe("0\n");
        expect(await fixture.run(`'${legacy}' --check`)).toContain(
          `linux\t${fixtureCase.architecture}\n`,
        );

        const candidateDigest = (
          await fixture.run(`sha256sum '${candidate}' | cut -d ' ' -f1`)
        ).trim();
        const managed = `${root}/bin/0.2.207/${candidateDigest}/bigbud-remote-agent`;
        await fixture.run(
          `mkdir -p -m 700 "$(dirname '${managed}')"; cp '${candidate}' '${managed}'; chmod 700 '${managed}'`,
        );
        expect(await fixture.run(`'${candidate}' --check`)).toContain(
          `linux\t${fixtureCase.architecture}\n`,
        );
        expect(
          await fixture.run(`find -P '${root}/bin' -type f -name bigbud-remote-agent | wc -l`),
        ).toBe("1\n");
        const staged = parseRemoteAgentInventory(
          await fixture.run(buildRemoteAgentInventoryCommand(root)),
        );
        expect(staged.uniqueDigests).toEqual(new Set([legacyDigest, candidateDigest]));
        expect(staged.entries.some((entry) => entry.kind === "legacy")).toBe(true);
        expect(staged.entries.some((entry) => entry.kind === "managed")).toBe(true);
        expect(staged.noncompliant).toBe(false);
      } finally {
        fixture.close();
      }
    }, 60_000);
  }
});
