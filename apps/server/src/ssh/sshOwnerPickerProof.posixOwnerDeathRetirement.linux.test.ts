import { randomBytes } from "node:crypto";
import { lstat, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Effect } from "effect";
import { expect, it } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

it.skipIf(process.platform !== "linux" || !pickerProofOptedIn)(
  "refuses a replacement in a fresh PID namespace after Linux owner death",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture();
    try {
      const binary = await fixture.installOwner(
        process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
          fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
      const targetId = `ssh:${new URLSearchParams({ host: fixture.loopback, port: String(fixture.port), user: fixture.user })}`;
      await writeFile(fixture.knownHosts, `${fixture.host} ${await fixture.getHostPublicKey()}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      const options = {
        binary,
        profileBinding: randomBytes(32),
        targetId,
        lockFile: path.join(fixture.root, "owner.lock"),
        sshBinary: fixture.ssh,
        keyscanBinary: fixture.keyscan,
        host: fixture.loopback,
        port: fixture.port,
        user: fixture.user,
        identityFile: fixture.identity,
        knownHostsFile: fixture.knownHosts,
        posixPickerMaster: true,
      } as const;
      await storageScope(path.join(fixture.root, "owner-retirement.sqlite"), (sql) =>
        Effect.gen(function* () {
          const start = () => startPickerProofOwner({ ...options, sql });
          const original = yield* Effect.acquireRelease(Effect.promise(start), (owner) =>
            Effect.promise(() => owner.close()),
          );
          const writer = sql<{ writer_epoch: string }>`SELECT writer_epoch FROM ssh_owner_writer`;
          const [oldWriter] = yield* writer;
          yield* Effect.promise(async () => {
            const trust = await original.inspectTrust();
            if (trust.state === "approvalRequired") await original.approveTrust(trust.challenge);
            await expect(
              original.listRemoteFolders({ executionTargetId: targetId, path: fixture.folder }),
            ).resolves.toMatchObject({ path: fixture.folder });
          });
          const entries = yield* Effect.promise(() => readdir(fixture.root));
          const lease = entries.find((entry) => /^bbcm-[A-Za-z0-9]{12}$/.test(entry));
          if (!lease) throw new Error("Expected the live Linux master lease");
          const socket = path.join(fixture.root, lease, "s");
          const inode = (yield* Effect.promise(() => lstat(socket))).ino;
          // Move the lease aside so only the per-instance journal can refuse.
          yield* Effect.promise(() =>
            rename(path.join(fixture.root, lease), path.join(fixture.root, "moved-lease")),
          );
          const masterName = entries.find((entry) => entry.startsWith("owner.retirement.master."));
          if (!masterName) throw new Error("Expected a per-instance master record");
          const text = yield* Effect.promise(() =>
            readFile(path.join(fixture.root, masterName), "utf8"),
          );
          expect(text).toContain("state=bound");
          expect(text).toMatch(/^pid=[1-9]\d*$/m);
          expect(text).toMatch(/^start=[1-9]\d*$/m);
          expect(text).toMatch(/^namespace=\d+$/m);

          yield* Effect.promise(() => original.killForTest());
          yield* Effect.promise(async () => {
            // The replacement runs in a fresh private PID namespace, so it must
            // refuse instead of adopting the prior namespace-local process.
            await expect(start().then((unexpected) => unexpected.close())).rejects.toMatchObject({
              code: "ownerRetirementUnverified",
            });
            expect((await lstat(socket)).ino).toBe(inode);
            expect(await readFile(path.join(fixture.root, masterName), "utf8")).toContain(
              "state=bound",
            );
          });
          expect(yield* writer).toEqual([oldWriter]);
        }).pipe(Effect.scoped),
      );
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);
