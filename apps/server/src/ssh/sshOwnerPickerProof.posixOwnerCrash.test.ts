import { lstat, readdir, rmdir, writeFile } from "node:fs/promises";
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

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "blocks a replacement after real picker-owner SIGKILL until disposable lease cleanup",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ boundIdleMasterLifetime: true });
    try {
      const options = await proofOptions(fixture, undefined, false, true);
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      await storageScope(path.join(fixture.root, "picker-crash.sqlite"), (sql) =>
        Effect.gen(function* () {
          const start = () => startPickerProofOwner({ ...options, posixPickerMaster: true, sql });
          const writer = sql<{ writer_epoch: string }>`SELECT writer_epoch FROM ssh_owner_writer`;
          const original = yield* Effect.acquireRelease(Effect.promise(start), (owner) =>
            Effect.promise(() => owner.close()),
          );
          yield* Effect.promise(async () => {
            await expect(picker(original, fixture)()).resolves.toMatchObject({
              path: fixture.folder,
            });
            await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
          });
          const [oldWriter] = yield* writer;
          expect(oldWriter?.writer_epoch).toEqual(expect.any(String));
          const entries = yield* Effect.promise(() => readdir(fixture.root));
          const leases = entries.filter((entry) => /^bbcm-[A-Za-z0-9]{12}$/.test(entry));
          expect(leases).toHaveLength(1);
          const directory = path.join(fixture.root, leases[0]!);
          const socket = path.join(directory, "s");
          const inode = (yield* Effect.promise(() => lstat(socket))).ino;
          const starts = fixture.connectionStarts();

          yield* Effect.promise(() => original.killForTest());
          yield* Effect.promise(async () => {
            await expect(start().then((unexpected) => unexpected.close())).rejects.toMatchObject({
              code: "ownerUnavailable",
            });
            expect(fixture.connectionStarts()).toBe(starts);
            expect((await lstat(socket)).ino).toBe(inode);
          });
          expect(yield* writer).toEqual([oldWriter]);

          // The fixture's own sshd has a short idle timeout. The test never
          // connects to, signals, or unlinks an unverified residual socket.
          yield* Effect.promise(() =>
            vi.waitFor(
              async () => {
                await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
              },
              { timeout: 15_000 },
            ),
          );
          yield* Effect.promise(async () => {
            await expect(start().then((unexpected) => unexpected.close())).rejects.toMatchObject({
              code: "ownerUnavailable",
            });
            expect(fixture.connectionStarts()).toBe(starts);
            // Only the harness, with its own disposed endpoint and an empty
            // test directory, can perform this cleanup. No owner auto-reap.
            await fixture.stop();
            expect(await readdir(directory)).toEqual([]);
            await rmdir(directory);
            await fixture.start();
          });
          const replacement = yield* Effect.acquireRelease(Effect.promise(start), (owner) =>
            Effect.promise(() => owner.close()),
          );
          expect(yield* writer).not.toEqual([oldWriter]);
          yield* Effect.promise(async () => {
            await expect(picker(replacement, fixture)()).resolves.toMatchObject({
              path: fixture.folder,
            });
            await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
          });
        }).pipe(Effect.scoped),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);
