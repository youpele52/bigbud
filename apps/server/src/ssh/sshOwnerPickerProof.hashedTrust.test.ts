import { execFileSync } from "node:child_process";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  picker,
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn)(
  "uses an exact hashed port pin and refuses a revoked replacement before SSH",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`);
      execFileSync("/usr/bin/ssh-keygen", ["-H", "-f", fixture.knownHosts], {
        cwd: fixture.root,
        env: fixture.env,
        timeout: 5_000,
        stdio: "ignore",
      });
      await chmod(fixture.knownHosts, 0o600);
      const hashed = await readFile(fixture.knownHosts, "utf8");
      expect(hashed).toMatch(/^\|1\|/);
      expect(hashed).not.toContain(fixture.host);
      await fixture.start();
      await storageScope(path.join(fixture.root, "hashed-trust.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({ ...options, sql });
          try {
            await expect(picker(owner, fixture)()).resolves.toMatchObject({ path: fixture.folder });
            expect(await readFile(fixture.knownHosts, "utf8")).toBe(hashed);
            await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
            const attempts = fixture.connectionStarts();
            await writeFile(fixture.knownHosts, `@revoked ${hashed}`);
            await expect(picker(owner, fixture)()).rejects.toMatchObject({
              cause: { code: "hostKeyChanged" },
            });
            expect(fixture.connectionStarts()).toBe(attempts);
            expect(fixture.acceptedPublicKeys()).toBe(1);
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);

it.skipIf(!pickerProofOptedIn)(
  "writes only the approved hashed host pin when HashKnownHosts is enabled",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      const alias = "proof-hashed-target";
      const targetId = `ssh:${alias}`;
      const file = path.join(fixture.root, "proof_config");
      await writeFile(
        file,
        [
          `Host ${alias}`,
          `  HostName ${fixture.loopback}`,
          `  Port ${fixture.port}`,
          `  User ${fixture.user}`,
          `  IdentityFile ${fixture.identity}`,
          `  UserKnownHostsFile ${fixture.knownHosts}`,
          "  HashKnownHosts yes",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      await fixture.start();
      await storageScope(path.join(fixture.root, "create-hashed-trust.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            targetId,
            sql,
            aliasConfig: { file, alias },
          });
          try {
            const list = picker(owner, fixture, targetId);
            await expect(list()).rejects.toMatchObject({ cause: { code: "trustRequired" } });
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired") throw new Error("Expected first-use approval");
            const entriesBefore = (await readdir(fixture.root)).toSorted();
            await owner.approveTrust(trust.challenge);
            expect((await readdir(fixture.root)).toSorted()).toEqual(entriesBefore);
            const hashed = await readFile(fixture.knownHosts, "utf8");
            expect(hashed).toMatch(/^\|1\|/);
            expect(hashed).not.toContain(fixture.host);
            await expect(list()).resolves.toMatchObject({ path: fixture.folder });
            expect(await readFile(fixture.knownHosts, "utf8")).toBe(hashed);
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);
