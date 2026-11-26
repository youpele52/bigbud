import { lstat, readdir, writeFile } from "node:fs/promises";
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
  "keeps the existing master on failed Disconnect and resumes only after fresh storage hydration",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture, undefined, false, true);
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      const db = path.join(fixture.root, "disconnect-failure.sqlite");
      const leases = async () =>
        (await readdir(fixture.root)).filter((name) => /^bbcm-[a-z0-9]{12}$/i.test(name));
      const oldEpoch = await storageScope(db, (sql) =>
        Effect.gen(function* () {
          const owner = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startPickerProofOwner({ ...options, posixPickerMaster: true, sql }),
            ),
            (owner) => Effect.promise(() => owner.close()),
          );
          const read = picker(owner, fixture);
          yield* Effect.promise(() =>
            expect(read()).resolves.toMatchObject({ path: fixture.folder }),
          );
          const before = yield* Effect.promise(leases);
          expect(before).toHaveLength(1);
          const socket = path.join(fixture.root, before[0]!, "s");
          const inode = (yield* Effect.promise(() => lstat(socket))).ino;
          // The flag write precedes the receipt insert. Force SQLite to roll both back.
          yield* sql`CREATE TRIGGER fail_disconnect BEFORE INSERT ON ssh_target_transition
            BEGIN SELECT RAISE(ABORT, 'synthetic transition fault'); END`;
          yield* Effect.promise(() =>
            expect(owner.disconnect()).rejects.toMatchObject({ code: "storageUnavailable" }),
          );
          expect(yield* sql`SELECT * FROM remote_execution_target_disconnects`).toEqual([]);
          expect(yield* sql`SELECT * FROM ssh_target_transition`).toEqual([]);
          expect(yield* Effect.promise(leases)).toEqual(before);
          expect((yield* Effect.promise(() => lstat(socket))).ino).toBe(inode);
          yield* sql`DROP TRIGGER fail_disconnect`;
          yield* Effect.promise(() =>
            expect(read()).rejects.toMatchObject({ cause: { code: "ownerUnavailable" } }),
          );
          expect(fixture.connectionStarts()).toBe(1);
          return Uint8Array.from(owner.ownerEpoch);
        }).pipe(Effect.scoped),
      );
      expect(await leases()).toEqual([]);
      await storageScope(db, (sql) =>
        Effect.gen(function* () {
          const owner = yield* Effect.acquireRelease(
            Effect.promise(() =>
              startPickerProofOwner({ ...options, posixPickerMaster: true, sql }),
            ),
            (owner) => Effect.promise(() => owner.close()),
          );
          expect(owner.ownerEpoch).not.toEqual(oldEpoch);
          const read = picker(owner, fixture);
          yield* Effect.promise(() =>
            expect(read()).resolves.toMatchObject({ path: fixture.folder }),
          );
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(2)),
          );
          yield* Effect.promise(() => owner.disconnect());
          expect(yield* sql`SELECT target_id FROM remote_execution_target_disconnects`).toEqual([
            { target_id: options.targetId },
          ]);
          expect(yield* sql`SELECT seq FROM ssh_target_transition`).toEqual([{ seq: 1 }]);
          expect(yield* Effect.promise(leases)).toEqual([]);
          yield* Effect.promise(() =>
            expect(read()).rejects.toMatchObject({ cause: { code: "targetDisconnected" } }),
          );
          expect(fixture.connectionStarts()).toBe(2);
        }).pipe(Effect.scoped),
      );
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);
