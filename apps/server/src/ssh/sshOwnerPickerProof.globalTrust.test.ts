import { chmod, link, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  picker,
  pickerProofOptedIn,
  proofOptions,
  rejectStartup,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "reads with global-only trust but cannot enroll or use the bootstrap anchor as trust",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const alias = "proof-global-trust";
      const label = "approved-global-host";
      const targetId = `ssh:${alias}`;
      const file = path.join(fixture.root, "global-config");
      const global = path.join(fixture.root, "global-pins");
      const anchorAlias = path.join(fixture.root, "global-hardlink");
      const matching = `${label} ${fixture.hostPublicKey}\n`;
      const missing = `unrelated ${fixture.hostPublicKey}\n`;
      await writeFile(fixture.knownHosts, matching, { mode: 0o600 });
      await writeFile(global, missing, { mode: 0o600 });
      const replaceGlobal = async (data: string) => {
        await chmod(global, 0o600);
        await writeFile(global, data);
        await chmod(global, 0o400);
      };
      await replaceGlobal(missing);
      await writeFile(
        file,
        [
          `Host ${alias}`,
          `  HostName ${fixture.loopback}`,
          `  Port ${fixture.port}`,
          `  User ${fixture.user}`,
          `  HostKeyAlias ${label}`,
          `  IdentityFile ${fixture.identity}`,
          "  UserKnownHostsFile none",
          `  GlobalKnownHostsFile ${global}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      const options = await proofOptions(fixture);
      await fixture.start();
      await storageScope(path.join(fixture.root, "global-trust.sqlite"), (sql) =>
        Effect.promise(async () => {
          const start = (knownHostsFile: string) =>
            startPickerProofOwner({
              ...options,
              sql,
              targetId,
              knownHostsFile,
              aliasConfig: { file, alias },
            });
          const attempts = fixture.connectionStarts();
          await rejectStartup(start(global), "ownerUnavailable");
          await link(global, anchorAlias);
          await rejectStartup(start(anchorAlias), "ownerUnavailable");
          await unlink(anchorAlias);
          expect(fixture.connectionStarts()).toBe(attempts);
          const owner = await start(fixture.knownHosts);
          try {
            const list = picker(owner, fixture, targetId);
            await expect(owner.inspectTrust()).rejects.toMatchObject({
              code: "trustStoreReadOnly",
            });
            await expect(owner.approveTrust(new Uint8Array(32))).rejects.toMatchObject({
              code: "operationDenied",
            });
            await expect(list()).rejects.toMatchObject({ cause: { code: "trustStoreReadOnly" } });
            expect(fixture.connectionStarts()).toBe(attempts);
            expect(await readFile(global, "utf8")).toBe(missing);
            expect(await readFile(fixture.knownHosts, "utf8")).toBe(matching);

            const wrong = `${label} ${fixture.wrongPublicKey}\n`;
            await replaceGlobal(wrong);
            await expect(owner.inspectTrust()).rejects.toMatchObject({ code: "hostKeyChanged" });
            await expect(list()).rejects.toMatchObject({ cause: { code: "hostKeyChanged" } });
            expect(fixture.acceptedPublicKeys()).toBe(0);
            expect(await readFile(global, "utf8")).toBe(wrong);

            await replaceGlobal(matching);
            await expect(owner.inspectTrust()).resolves.toMatchObject({ state: "verified" });
            await expect(list()).resolves.toEqual({
              path: fixture.folder,
              homePath: fixture.home,
              folders: [
                { name: "alpha", isGitRepo: false },
                { name: "Z repo", isGitRepo: true },
              ],
              truncated: false,
            });
            await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
            expect(await readFile(global, "utf8")).toBe(matching);

            for (const [marker, code] of [
              ["@revoked", "hostKeyChanged"],
              ["@cert-authority", "configUnsupported"],
            ] as const) {
              const denied = `${matching}${marker} ${matching}`;
              await replaceGlobal(denied);
              const before = fixture.connectionStarts();
              await expect(owner.inspectTrust()).rejects.toMatchObject({ code });
              await expect(list()).rejects.toMatchObject({ cause: { code } });
              expect(fixture.connectionStarts()).toBe(before);
              expect(await readFile(global, "utf8")).toBe(denied);
            }
            expect(await readFile(fixture.knownHosts, "utf8")).toBe(matching);
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
