import { lstat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "cancels a live direct picker read and accepts a distinct request on the same owner",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ pauseFirstPickerCommand: true });
    try {
      const options = await proofOptions(fixture);
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      await storageScope(path.join(fixture.root, "picker-cancel.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            sql,
            posixPickerCancellation: true,
          });
          const input = {
            executionTargetId: fixture.executionTargetId,
            path: `~/${path.basename(fixture.folder)}`,
          };
          const controller = new AbortController();
          const epoch = owner.ownerEpoch;
          try {
            await expect(
              owner.listCancellableRemoteFolders(input, AbortSignal.abort()),
            ).rejects.toMatchObject({ code: "listCancelled" });
            expect(fixture.connectionStarts()).toBe(0);
            const active = owner.listCancellableRemoteFolders(input, controller.signal);
            void active.catch(() => undefined);
            await vi.waitFor(async () =>
              expect((await lstat(path.join(fixture.root, "held-picker-read"))).isDirectory()).toBe(
                true,
              ),
            );
            const start = performance.now();
            controller.abort();
            await expect(active).rejects.toMatchObject({ code: "listCancelled" });
            expect(performance.now() - start).toBeLessThan(3_000);
            expect(fixture.connectionStarts()).toBe(1);
            await writeFile(path.join(fixture.root, "release-picker-read"), "");
            await expect(owner.listRemoteFolders(input)).resolves.toMatchObject({
              path: fixture.folder,
              folders: [{ name: "alpha" }, { name: "Z repo" }],
            });
            expect(owner.ownerEpoch).toEqual(epoch);
            expect(fixture.connectionStarts()).toBe(2);
            expect(await fixture.launchNames()).toEqual([]);
          } finally {
            controller.abort();
            await writeFile(path.join(fixture.root, "release-picker-read"), "");
            await owner.close();
          }
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "cancels a live mux-backed picker read and reaps only its owned local master",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ pauseFirstPickerCommand: true });
    try {
      const options = await proofOptions(fixture, undefined, false, true);
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      await storageScope(path.join(fixture.root, "mux-picker-cancel.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            sql,
            posixMuxPickerCancellation: true,
          });
          const input = {
            executionTargetId: fixture.executionTargetId,
            path: `~/${path.basename(fixture.folder)}`,
          };
          const controller = new AbortController();
          const leases = async () =>
            (await readdir(fixture.root)).filter((entry) => /^bbcm-[A-Za-z0-9]{12}$/.test(entry));
          const epoch = owner.ownerEpoch;
          try {
            const active = owner.listCancellableRemoteFolders(input, controller.signal);
            void active.catch(() => undefined);
            await vi.waitFor(async () =>
              expect((await lstat(path.join(fixture.root, "held-picker-read"))).isDirectory()).toBe(
                true,
              ),
            );
            const before = await leases();
            expect(before).toHaveLength(1);
            const [lease] = before;
            if (!lease) throw new Error("Expected the fixture's owned mux lease");
            const socket = path.join(fixture.root, lease, "s");
            expect((await lstat(socket)).isSocket()).toBe(true);
            expect(fixture.acceptedPublicKeys()).toBe(1);

            const started = performance.now();
            controller.abort();
            await expect(active).rejects.toMatchObject({ code: "listCancelled" });
            expect(performance.now() - started).toBeLessThan(3_000);
            await expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" });
            expect(await leases()).toEqual([]);
            expect(fixture.connectionStarts()).toBe(1);
            // Local teardown does not establish remote command termination.
            // Release the disposable remote barrier independently.
            await writeFile(path.join(fixture.root, "release-picker-read"), "");
            await expect(
              owner.listCancellableRemoteFolders(input, new AbortController().signal),
            ).resolves.toMatchObject({ path: fixture.folder });
            expect(owner.ownerEpoch).toEqual(epoch);
            await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(2));
            expect(await leases()).toHaveLength(1);
            expect(await fixture.launchNames()).toEqual([]);
          } finally {
            controller.abort();
            await writeFile(path.join(fixture.root, "release-picker-read"), "");
            await owner.close();
          }
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);
