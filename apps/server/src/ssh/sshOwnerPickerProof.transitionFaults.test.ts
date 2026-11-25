import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { applySshOwnerTransition } from "../persistence/Layers/SshOwnerTransitions.ts";
import {
  commitTransitionWithoutReply,
  durableTransition,
  isFixtureChildAlive,
  openReadyTerminal,
  sendStaleConnect,
  writerEpoch,
} from "./sshOwnerPickerProof.attachment.fixture.ts";
import {
  attachPickerProofOwner,
  startPickerProofOwner,
  type LaunchedPickerProofOwner,
} from "./sshOwnerPickerProof.client.ts";
import { withOutsideMaster } from "./sshOwnerPickerProof.fixture.ts";
import {
  picker,
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

const disconnected = { cause: { code: "targetDisconnected" } };

async function prepare(allowPty: boolean) {
  const fixture = await makeLoopbackPickerFixture({ allowPty });
  const socketPath = path.join(fixture.root, "owner.sock");
  const options = await proofOptions(fixture, socketPath, allowPty);
  await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
    mode: 0o600,
  });
  await fixture.start();
  const attachment = {
    socketPath,
    capability: randomBytes(32),
    profileBinding: options.profileBinding,
    targetId: options.targetId,
  };
  return { fixture, options, attachment, db: path.join(fixture.root, "faults.sqlite") };
}

it.skipIf(!pickerProofOptedIn)(
  "recovers a committed Disconnect whose reply was lost while the owner and PTY survived",
  async () => {
    const { fixture, options, attachment, db } = await prepare(true);
    let bootstrap: LaunchedPickerProofOwner | undefined;
    try {
      await withOutsideMaster(fixture, fixture.host, async (outsideAlive) => {
        const committed = await storageScope(db, (sql) =>
          Effect.promise(async () => {
            bootstrap = await startPickerProofOwner({ ...options, sql, attachment });
            await expect(picker(bootstrap, fixture)()).resolves.toMatchObject({
              path: fixture.folder,
            });
            const terminal = await openReadyTerminal(bootstrap);
            await bootstrap.detach();
            const receipt = await commitTransitionWithoutReply({
              ...attachment,
              sql,
              action: "disconnect",
            });
            expect(receipt.seq).toBe(1);
            const durable = await durableTransition(sql, options.targetId);
            expect(durable.receipt?.seq).toBe(1);
            expect(durable.disconnectedAt).toBeTypeOf("number");
            // No reply reached the owner: it has not acted on the commit yet.
            expect(isFixtureChildAlive(terminal.pid)).toBe(true);
            return { durable, terminal, writer: receipt.writerEpoch };
          }),
        );
        const baseline = fixture.connectionStarts();
        // Backend restart: a fresh SQLite scope and client hydrate the committed flag.
        await storageScope(db, (sql) =>
          Effect.promise(async () => {
            const attached = await attachPickerProofOwner({ ...attachment, sql });
            expect(isFixtureChildAlive(committed.terminal.pid)).toBe(false);
            expect(await writerEpoch(sql)).not.toBe(committed.writer);
            expect(await durableTransition(sql, options.targetId)).toEqual(committed.durable);
            await expect(picker(attached, fixture)()).rejects.toMatchObject(disconnected);
            await expect(attached.openProofTerminal()).rejects.toThrow();
            // The original lease was retired once; a second close is refused, not repeated.
            await expect(
              attached.closeProofTerminal(committed.terminal.lease),
            ).rejects.toMatchObject({ code: "targetDisconnected" });
            expect(fixture.connectionStarts()).toBe(baseline);
            await outsideAlive();
            await attached.close();
          }),
        );
        // A second restart finds nothing left to tear down and still admits nothing.
        await storageScope(db, (sql) =>
          Effect.promise(async () => {
            const attached = await attachPickerProofOwner({ ...attachment, sql });
            try {
              expect(await durableTransition(sql, options.targetId)).toEqual(committed.durable);
              await expect(picker(attached, fixture)()).rejects.toMatchObject(disconnected);
              expect(fixture.connectionStarts()).toBe(baseline);
              await outsideAlive();
              await attached.connect();
              const connected = await durableTransition(sql, options.targetId);
              expect(connected.disconnectedAt).toBeUndefined();
              expect(connected.receipt?.seq).toBe(2);
              expect(fixture.connectionStarts()).toBe(baseline);
              await expect(picker(attached, fixture)()).resolves.toMatchObject({
                path: fixture.folder,
              });
              expect(fixture.connectionStarts()).toBe(baseline + 1);
              // After Connect the retired lease is unknown, not closed again.
              await expect(
                attached.closeProofTerminal(committed.terminal.lease),
              ).rejects.toMatchObject({ code: "operationDenied" });
              await outsideAlive();
            } finally {
              await attached.close();
            }
          }),
        );
      });
    } finally {
      await bootstrap?.killForTest();
      await bootstrap?.close();
      await fixture.dispose();
    }
  },
  120_000,
);

it.skipIf(!pickerProofOptedIn)(
  "rejects a delayed old-epoch Connect after a newer Disconnect without side effects",
  async () => {
    const { fixture, options, attachment, db } = await prepare(false);
    let bootstrap: LaunchedPickerProofOwner | undefined;
    try {
      await withOutsideMaster(fixture, fixture.host, async (outsideAlive) => {
        const old = await storageScope(db, (sql) =>
          Effect.promise(async () => {
            bootstrap = await startPickerProofOwner({ ...options, sql, attachment });
            await expect(picker(bootstrap, fixture)()).resolves.toMatchObject({
              path: fixture.folder,
            });
            await bootstrap.detach();
            // The Connect was formed for this writer and generation, then delayed.
            const generation = await sendStaleConnect({ ...attachment, sql });
            return { generation, writer: await writerEpoch(sql) };
          }),
        );
        const newer = await storageScope(db, (sql) =>
          Effect.promise(async () => {
            const attached = await attachPickerProofOwner({ ...attachment, sql });
            await attached.disconnect();
            await attached.close();
            return durableTransition(sql, options.targetId);
          }),
        );
        expect(newer.receipt?.seq).toBe(1);
        const baseline = fixture.connectionStarts();
        await storageScope(db, (sql) =>
          Effect.promise(async () => {
            const delayed = await Effect.runPromise(
              applySshOwnerTransition(sql, {
                writerEpoch: old.writer,
                targetId: options.targetId,
                requestId: "delayed-old-connect",
                expectedSeq: 0,
                desiredState: "connected",
              }),
            );
            expect(delayed).toEqual({ kind: "epochMismatch" });
            await sendStaleConnect({ ...attachment, sql, staleGeneration: old.generation });
            expect(await durableTransition(sql, options.targetId)).toEqual(newer);
            const attached = await attachPickerProofOwner({ ...attachment, sql });
            try {
              await expect(picker(attached, fixture)()).rejects.toMatchObject(disconnected);
              expect(await durableTransition(sql, options.targetId)).toEqual(newer);
              expect(fixture.connectionStarts()).toBe(baseline);
              await outsideAlive();
            } finally {
              await attached.close();
            }
          }),
        );
      });
    } finally {
      await bootstrap?.killForTest();
      await bootstrap?.close();
      await fixture.dispose();
    }
  },
  120_000,
);
