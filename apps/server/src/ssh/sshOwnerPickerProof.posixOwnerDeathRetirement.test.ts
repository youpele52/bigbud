import { lstat, readFile, readdir, rename, writeFile } from "node:fs/promises";
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

const record = async (root: string, name: string) => {
  const text = await readFile(path.join(root, name), "utf8");
  const value = (key: string) => new RegExp(`^${key}=(.+)$`, "m").exec(text)?.[1];
  return {
    state: value("state"),
    pid: Number(value("pid")),
    start: value("start"),
    namespace: value("namespace"),
  };
};

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "refuses a replacement on the exact live master after owner death without touching it",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    let masterPid: number | undefined;
    try {
      const options = await proofOptions(fixture, undefined, false, true);
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      await storageScope(path.join(fixture.root, "owner-retirement.sqlite"), (sql) =>
        Effect.gen(function* () {
          const start = () => startPickerProofOwner({ ...options, posixPickerMaster: true, sql });
          const original = yield* Effect.acquireRelease(Effect.promise(start), (owner) =>
            Effect.promise(() => owner.close()),
          );
          const writer = sql<{ writer_epoch: string }>`SELECT writer_epoch FROM ssh_owner_writer`;
          const [oldWriter] = yield* writer;
          yield* Effect.promise(async () => {
            await expect(picker(original, fixture)()).resolves.toMatchObject({
              path: fixture.folder,
            });
            await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1));
          });
          const entries = yield* Effect.promise(() => readdir(fixture.root));
          const lease = entries.find((entry) => /^bbcm-[A-Za-z0-9]{12}$/.test(entry));
          if (!lease) throw new Error("Expected the live master lease");
          const socket = path.join(fixture.root, lease, "s");
          const inode = (yield* Effect.promise(() => lstat(socket))).ino;
          const intent = yield* Effect.promise(() => record(fixture.root, "owner.retirement"));
          const masterName = entries.find((entry) => entry.startsWith("owner.retirement.master."));
          if (!masterName) throw new Error("Expected a per-instance master record");
          const master = yield* Effect.promise(() => record(fixture.root, masterName));
          expect(intent.state).toBe("bound");
          expect(master.state).toBe("bound");
          expect(master.pid).toBeGreaterThan(0);
          expect(master.start).not.toBe("0");
          masterPid = master.pid;
          const starts = fixture.connectionStarts();

          yield* Effect.promise(() => original.killForTest());
          yield* Effect.promise(async () => {
            // The lease and the journal both exist; the replacement must not
            // adopt, signal, connect to or unlink either of them.
            await expect(start().then((unexpected) => unexpected.close())).rejects.toMatchObject({
              code: expect.stringMatching(/^(?:ownerUnavailable|ownerRetirementUnverified)$/),
            });
            expect(fixture.connectionStarts()).toBe(starts);
            expect((await lstat(socket)).ino).toBe(inode);
            expect(alive(master.pid)).toBe(true);
            expect((await record(fixture.root, masterName)).pid).toBe(master.pid);
          });

          // Move the residual lease aside. The live exact master record alone
          // must still refuse, proving the journal is independently binding.
          yield* Effect.promise(() =>
            rename(path.join(fixture.root, lease), path.join(fixture.root, "moved-lease")),
          );
          yield* Effect.promise(async () => {
            await expect(start().then((unexpected) => unexpected.close())).rejects.toMatchObject({
              code: "ownerRetirementUnverified",
            });
            expect(fixture.connectionStarts()).toBe(starts);
            expect(alive(master.pid)).toBe(true);
            expect((await record(fixture.root, masterName)).pid).toBe(master.pid);
          });
          expect(yield* writer).toEqual([oldWriter]);
        }).pipe(Effect.scoped),
      );
    } finally {
      if (masterPid !== undefined && alive(masterPid)) {
        process.kill(masterPid, "SIGKILL");
        await vi.waitFor(() => expect(alive(masterPid!)).toBe(false));
      }
      await fixture.dispose();
    }
  },
  120_000,
);
