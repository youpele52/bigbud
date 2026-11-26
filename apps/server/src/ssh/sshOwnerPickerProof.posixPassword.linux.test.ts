import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { prepareProofOwner } from "./sshOwnerPickerProof.posixPassword.fixture.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

async function masterDirectories(root: string) {
  return (await readdir(root)).filter((name) => name.startsWith("bbcm-"));
}

it.skipIf(process.platform !== "linux" || !pickerProofOptedIn)(
  "unlocks a pinned stock password master once, reuses it, and stays disconnected without fallback",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture({ syntheticPassword: true });
    try {
      const pin = `${fixture.host} ${await fixture.getHostPublicKey()}\n`;
      await writeFile(fixture.knownHosts, pin, { mode: 0o600 });
      const { options, targetId } = await prepareProofOwner(fixture);
      const assertDaemonCounts = async (count: number) => {
        const log = await fixture.readPasswordDaemonLog();
        // Count rejected connections too: none of these steps may try an independent SSH path.
        expect(log.match(/^Connection from /gm) ?? []).toHaveLength(count);
        expect(
          log.match(/^Accepted password for picker from 127\.0\.0\.1 port /gm) ?? [],
        ).toHaveLength(count);
        expect(log).not.toMatch(/^Accepted (?!password )/m);
      };
      const listInput = { executionTargetId: targetId, path: fixture.folder };
      await storageScope(path.join(fixture.root, "password-picker.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({ ...options, sql });
          try {
            await expect(owner.listRemoteFolders(listInput)).rejects.toMatchObject({
              code: "authRequired",
            });
            await assertDaemonCounts(0);
            expect(await masterDirectories(fixture.root)).toEqual([]);

            await owner.unlockSyntheticPosixPassword();
            const listing = {
              path: fixture.folder,
              homePath: fixture.home,
              folders: [
                { name: "alpha", isGitRepo: false },
                { name: "Z repo", isGitRepo: true },
              ],
              truncated: false,
            };
            await expect(owner.listRemoteFolders(listInput)).resolves.toEqual(listing);
            await vi.waitFor(() => assertDaemonCounts(1));
            const directories = await masterDirectories(fixture.root);
            expect(directories).toEqual([expect.stringMatching(/^bbcm-[a-zA-Z0-9]{12}$/)]);
            const [directory] = directories;
            if (!directory) throw new Error("Expected the owner's private mux lease");
            const socket = path.join(fixture.root, directory, "s");
            const initial = await lstat(socket, { bigint: true });
            expect(initial.isSocket()).toBe(true);
            expect(initial.mode & 0o7777n).toBe(0o600n);

            await expect(owner.listRemoteFolders(listInput)).resolves.toEqual(listing);
            const repeated = await lstat(socket, { bigint: true });
            expect([repeated.dev, repeated.ino]).toEqual([initial.dev, initial.ino]);
            expect(await masterDirectories(fixture.root)).toEqual(directories);
            await assertDaemonCounts(1);
            expect(await readFile(fixture.knownHosts, "utf8")).toBe(pin);

            await expect(owner.disconnect()).resolves.toEqual({ state: "disconnected" });
            await vi.waitFor(async () => expect(await masterDirectories(fixture.root)).toEqual([]));
            await expect(owner.unlockSyntheticPosixPassword()).rejects.toMatchObject({
              code: "targetDisconnected",
            });
            await expect(owner.listRemoteFolders(listInput)).rejects.toMatchObject({
              code: "targetDisconnected",
            });
            await assertDaemonCounts(1);
          } finally {
            await owner.close();
          }

          // Start a fresh native owner and sshd namespace against the same durable state.
          const replacement = await startPickerProofOwner({ ...options, sql });
          try {
            await expect(replacement.unlockSyntheticPosixPassword()).rejects.toMatchObject({
              code: "targetDisconnected",
            });
            await expect(replacement.listRemoteFolders(listInput)).rejects.toMatchObject({
              code: "targetDisconnected",
            });
            await expect(replacement.connect()).resolves.toEqual({ state: "connected" });
            await expect(replacement.listRemoteFolders(listInput)).rejects.toMatchObject({
              code: "authRequired",
            });
            await assertDaemonCounts(0);
            expect(await masterDirectories(fixture.root)).toEqual([]);
          } finally {
            await replacement.close();
          }
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);

it
  .skipIf(process.platform !== "linux" || !pickerProofOptedIn)
  .each(["wrong-password", "wrong-pin"] as const)(
  "rejects %s without retaining an unlocked master or opening a fallback connection",
  async (fault) => {
    const fixture = await makeLinuxLoopbackPickerFixture({
      syntheticPassword: true,
      rejectSyntheticPassword: fault === "wrong-password",
    });
    try {
      const key =
        fault === "wrong-pin"
          ? (await readFile(`${fixture.identity}.pub`, "utf8"))
              .trim()
              .split(" ")
              .slice(0, 2)
              .join(" ")
          : await fixture.getHostPublicKey();
      await writeFile(fixture.knownHosts, `${fixture.host} ${key}\n`, { mode: 0o600 });
      const { options, targetId } = await prepareProofOwner(fixture);
      const input = { executionTargetId: targetId, path: fixture.folder };
      await storageScope(path.join(fixture.root, "password-rejection.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({ ...options, sql });
          try {
            await expect(owner.unlockSyntheticPosixPassword()).rejects.toMatchObject({
              code: expect.stringMatching(/^(?:transportLost|authRequired|hostKeyChanged)$/),
            });
            await expect(owner.listRemoteFolders(input)).rejects.toMatchObject({
              code: "authRequired",
            });
            await vi.waitFor(async () => {
              const log = await fixture.readPasswordDaemonLog();
              expect(log.match(/^Connection from /gm) ?? []).toHaveLength(1);
              expect(log).not.toMatch(/^Accepted /m);
              if (fault === "wrong-password") expect(log).toMatch(/^Failed password for picker /m);
              else expect(log).not.toMatch(/^(?:Failed|Accepted) password /m);
            });
            expect(await masterDirectories(fixture.root)).toEqual([]);
          } finally {
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

it.skipIf(process.platform !== "linux" || !pickerProofOptedIn)(
  "fences the real crashed password owner even if its replacement omits the mode",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture({ syntheticPassword: true });
    try {
      await writeFile(fixture.knownHosts, `${fixture.host} ${await fixture.getHostPublicKey()}\n`, {
        mode: 0o600,
      });
      const { options, targetId } = await prepareProofOwner(fixture);
      const { posixSyntheticPasswordFixture, ...direct } = options;
      await storageScope(path.join(fixture.root, "password-crash-fence.sqlite"), (sql) =>
        Effect.scoped(
          Effect.gen(function* () {
            const owner = yield* Effect.acquireRelease(
              Effect.promise(() => startPickerProofOwner({ ...options, sql })),
              (value) => Effect.promise(() => value.close()),
            );
            yield* Effect.promise(async () => {
              await owner.unlockSyntheticPosixPassword();
              await expect(
                owner.listRemoteFolders({ executionTargetId: targetId, path: fixture.folder }),
              ).resolves.toMatchObject({ path: fixture.folder });
            });
            const writer = sql<{ writer_epoch: string }>`SELECT writer_epoch FROM ssh_owner_writer`;
            const before = yield* writer;
            expect(before).toEqual([{ writer_epoch: expect.any(String) }]);
            const leases = yield* Effect.promise(() => masterDirectories(fixture.root));
            expect(leases).toHaveLength(1);
            const [lease] = leases;
            if (!lease) throw new Error("Missing the verified password master directory");
            const directory = path.join(fixture.root, lease);
            const identity = yield* Effect.promise(() => lstat(directory, { bigint: true }));

            yield* Effect.promise(() => owner.killForTest());
            for (const selection of [direct, { ...direct, posixSyntheticPasswordFixture }]) {
              yield* Effect.promise(async () => {
                await expect(
                  startPickerProofOwner({ ...selection, sql }).then((unexpected) =>
                    unexpected.close(),
                  ),
                ).rejects.toMatchObject({ code: "ownerUnavailable" });
                // Each attempted startup gets a fresh, disposable sshd namespace;
                // the new log must not contain even an unauthenticated connection.
                expect(await fixture.readPasswordDaemonLog()).not.toMatch(/^Connection from /m);
                const residual = await lstat(directory, { bigint: true });
                expect([residual.dev, residual.ino]).toEqual([identity.dev, identity.ino]);
              });
              expect(yield* writer).toEqual(before);
            }
          }),
        ),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);

it.skipIf(process.platform !== "linux" || !pickerProofOptedIn)(
  "relocks after a real password-master transport loss and only unlocks on new intent",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture({
      syntheticPassword: true,
      boundIdlePasswordMasterLifetime: true,
    });
    try {
      await writeFile(fixture.knownHosts, `${fixture.host} ${await fixture.getHostPublicKey()}\n`, {
        mode: 0o600,
      });
      const { options, targetId } = await prepareProofOwner(fixture);
      await storageScope(path.join(fixture.root, "password-relock.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({ ...options, sql });
          const input = { executionTargetId: targetId, path: fixture.folder };
          const authCount = async () =>
            (await fixture.readPasswordDaemonLog()).match(/^Accepted password for picker /gm)
              ?.length ?? 0;
          const dialCount = async () =>
            (await fixture.readPasswordDaemonLog()).match(/^Connection from /gm)?.length ?? 0;
          try {
            await owner.unlockSyntheticPosixPassword();
            const listing = await owner.listRemoteFolders(input);
            expect(listing.path).toBe(fixture.folder);
            await vi.waitFor(async () => expect(await authCount()).toBe(1));
            const leases = await masterDirectories(fixture.root);
            expect(leases).toHaveLength(1);
            const [lease] = leases;
            if (!lease) throw new Error("Missing the authenticated test master");
            const socket = path.join(fixture.root, lease, "s");
            // Let stock sshd terminate the idle master; keep the Rust owner alive.
            await vi.waitFor(
              () => expect(lstat(socket)).rejects.toMatchObject({ code: "ENOENT" }),
              { timeout: 15_000 },
            );
            await expect(owner.listRemoteFolders(input)).rejects.toMatchObject({
              code: "transportLost",
            });
            expect(await dialCount()).toBe(1);
            await delay(300);
            await expect(owner.listRemoteFolders(input)).rejects.toMatchObject({
              code: "authRequired",
            });
            expect(await dialCount()).toBe(1);
            expect(await masterDirectories(fixture.root)).toEqual([]);

            await owner.unlockSyntheticPosixPassword();
            await expect(owner.listRemoteFolders(input)).resolves.toEqual(listing);
            await vi.waitFor(async () => expect(await authCount()).toBe(2));
            expect(await dialCount()).toBe(2);
          } finally {
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
