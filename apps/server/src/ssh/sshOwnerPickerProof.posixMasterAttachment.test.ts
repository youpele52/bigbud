import { randomBytes } from "node:crypto";
import { lstat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import {
  attachPickerProofOwner,
  startPickerProofOwner,
  type LaunchedPickerProofOwner,
} from "./sshOwnerPickerProof.client.ts";
import {
  picker,
  pickerProofOptedIn,
  proofOptions,
  rejectStartup,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "fences a live master across authenticated external reattachment and actual SQLite writer rotation",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    let bootstrap: LaunchedPickerProofOwner | undefined;
    try {
      const db = path.join(fixture.root, "master-attachment.sqlite");
      const socketPath = path.join(fixture.root, "owner.sock");
      const options = await proofOptions(fixture, socketPath, false, true);
      const attachment = {
        socketPath,
        capability: randomBytes(32),
        profileBinding: options.profileBinding,
        targetId: options.targetId,
      };
      const leases = async () =>
        (await readdir(fixture.root)).filter((name) => /^bbcm-[A-Za-z0-9]{12}$/.test(name));
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      const snapshot = await storageScope(db, (sql) =>
        Effect.gen(function* () {
          const writer = sql<{ writer_epoch: string }>`SELECT writer_epoch FROM ssh_owner_writer`;
          const owner = yield* Effect.promise(() =>
            startPickerProofOwner({ ...options, sql, posixPickerMaster: true, attachment }),
          );
          bootstrap = owner;
          yield* Effect.promise(() => owner.detach());
          const session = yield* Effect.promise(() =>
            attachPickerProofOwner({ ...attachment, sql }),
          );
          try {
            const list = picker(session, fixture);
            yield* Effect.promise(() =>
              expect(list()).resolves.toMatchObject({ path: fixture.folder }),
            );
            yield* Effect.promise(() =>
              vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(1)),
            );
            const [lease] = yield* Effect.promise(leases);
            if (!lease) throw new Error("Expected the first attachment's owned master");
            const socket = path.join(fixture.root, lease, "s");
            const { ino } = yield* Effect.promise(() => lstat(socket));
            return { lease, socket, ino, writer: yield* writer, epoch: session.ownerEpoch };
          } finally {
            yield* Effect.promise(() => session.close());
          }
        }),
      );
      await storageScope(db, (sql) =>
        Effect.gen(function* () {
          const writer = sql<{ writer_epoch: string }>`SELECT writer_epoch FROM ssh_owner_writer`;
          yield* Effect.promise(() =>
            rejectStartup(
              attachPickerProofOwner({ ...attachment, sql, capability: randomBytes(32) }),
              "operationDenied",
            ),
          );
          expect(yield* writer).toEqual(snapshot.writer);
          expect((yield* Effect.promise(() => lstat(snapshot.socket))).ino).toBe(snapshot.ino);
          expect(fixture.connectionStarts()).toBe(1);
          const attached = yield* Effect.promise(() =>
            attachPickerProofOwner({ ...attachment, sql }),
          );
          try {
            expect(attached.ownerEpoch).toEqual(snapshot.epoch);
            expect(yield* writer).not.toEqual(snapshot.writer);
            expect(yield* Effect.promise(leases)).toEqual([]);
            expect(fixture.connectionStarts()).toBe(1);
            yield* Effect.promise(() =>
              expect(picker(attached, fixture)()).resolves.toMatchObject({ path: fixture.folder }),
            );
            const [replacement] = yield* Effect.promise(leases);
            expect(replacement).toEqual(expect.any(String));
            expect(replacement).not.toBe(snapshot.lease);
            yield* Effect.promise(() =>
              vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(2)),
            );
            expect(fixture.connectionStarts()).toBe(2);
            yield* Effect.promise(() => attached.disconnect());
            expect(yield* Effect.promise(leases)).toEqual([]);
          } finally {
            yield* Effect.promise(() => attached.close());
          }
        }),
      );
    } finally {
      await bootstrap?.killForTest();
      await bootstrap?.close();
      await fixture.dispose();
    }
  },
  120_000,
);
