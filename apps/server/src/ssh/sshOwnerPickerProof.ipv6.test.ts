import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { expect, it } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  picker,
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn)(
  "binds IPv6 trust and browsing to the approved loopback alias",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ ipv6: true });
    try {
      const alias = "picker-v6";
      const targetId = `ssh:${alias}`;
      const file = path.join(fixture.root, "ssh-config-v6");
      const firstIdentity = path.join(fixture.root, "unaccepted-key");
      execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", firstIdentity], {
        cwd: fixture.root,
        env: fixture.env,
        timeout: 5_000,
      });
      await writeFile(
        file,
        [
          `Host ${alias}`,
          `HostName ${fixture.loopback}`,
          "AddressFamily inet6",
          `Port ${fixture.port}`,
          `User ${fixture.user}`,
          `IdentityFile ${firstIdentity}`,
          `IdentityFile ${fixture.identity}`,
          `UserKnownHostsFile ${fixture.knownHosts}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const options = await proofOptions(fixture);
      await fixture.start();
      await storageScope(path.join(fixture.root, "v6.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            targetId,
            identityFile: firstIdentity,
            sql,
            aliasConfig: { file, alias },
          });
          try {
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired")
              throw new Error("expected approval for the new IPv6 pin");
            await owner.approveTrust(trust.challenge);
            expect(await readFile(fixture.knownHosts, "utf8")).toBe(
              `${fixture.host} ${fixture.hostPublicKey}\n`,
            );
            await expect(picker(owner, fixture, targetId)()).resolves.toMatchObject({
              path: fixture.folder,
            });
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
