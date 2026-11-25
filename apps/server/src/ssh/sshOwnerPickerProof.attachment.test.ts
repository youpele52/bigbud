import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { applySshOwnerTransition } from "../persistence/Layers/SshOwnerTransitions.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";
import {
  commitTransitionWithoutReply,
  isFixtureChildAlive,
  openReadyTerminal,
  writerEpoch,
} from "./sshOwnerPickerProof.attachment.fixture.ts";
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

it.skipIf(!pickerProofOptedIn).each(["acknowledged", "lost receipt"] as const)(
  "reattaches the same isolated Rust owner after a %s Disconnect and fresh SQLite hydration",
  async (receiptMode) => {
    const fixture = await makeLoopbackPickerFixture({ allowPty: true });
    let bootstrapOwner: LaunchedPickerProofOwner | undefined;
    try {
      const db = path.join(fixture.root, "attachment.sqlite");
      const socketPath = path.join(fixture.root, "owner.sock");
      const capability = randomBytes(32);
      const options = await proofOptions(fixture, socketPath);
      await fixture.start();
      const original = await storageScope(db, (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            sql,
            attachment: { socketPath, capability },
          });
          bootstrapOwner = owner;
          const trust = await owner.inspectTrust();
          if (trust.state !== "approvalRequired")
            throw new Error("Expected an unpinned fixture host");
          await owner.approveTrust(trust.challenge);
          await expect(picker(owner, fixture)()).resolves.toMatchObject({ path: fixture.folder });
          const terminal = await openReadyTerminal(owner);
          await expect(owner.resizeProofTerminal(terminal.lease, 100, 30)).resolves.toMatchObject({
            pid: terminal.pid,
            live: true,
          });
          const text = Buffer.from("literal ; proof\n");
          await owner.writeProofTerminalInput(terminal.lease, 1, text);
          await vi.waitFor(async () => {
            const status = await owner.proofTerminalStatus(terminal.lease);
            expect(Buffer.from(status.sample).toString()).toContain(
              "BIGBUD_SSH_OWNER_PROOF_PTY_ECHO:literal ; proof",
            );
          });
          await expect(owner.openProofTerminal()).rejects.toMatchObject({
            code: "operationDenied",
          });
          expect(isFixtureChildAlive(terminal.pid)).toBe(true);
          if (receiptMode === "acknowledged") {
            await owner.disconnect();
            expect(isFixtureChildAlive(terminal.pid)).toBe(false);
          }
          const metadata = await lstat(socketPath);
          expect(metadata.isSocket()).toBe(true);
          expect(metadata.mode & 0o777).toBe(0o600);
          expect(metadata.uid).toBe(process.getuid?.());
          const epoch = Uint8Array.from(owner.ownerEpoch);
          await owner.detach();
          if (receiptMode === "lost receipt") {
            const receipt = await commitTransitionWithoutReply({
              action: "disconnect",
              socketPath,
              capability,
              sql,
              profileBinding: options.profileBinding,
              targetId: options.targetId,
            });
            expect(receipt.seq).toBe(1);
          }
          const writer = await writerEpoch(sql);
          expect(isFixtureChildAlive(terminal.pid)).toBe(receiptMode === "lost receipt");
          return { writer, epoch, terminal };
        }),
      );

      await storageScope(db, (sql) =>
        Effect.promise(async () => {
          const args = {
            socketPath,
            capability,
            sql,
            profileBinding: options.profileBinding,
            targetId: options.targetId,
          };
          const baseline = fixture.connectionStarts();
          for (const invalid of [
            { capability: randomBytes(32) },
            { profileBinding: randomBytes(32) },
          ]) {
            await rejectStartup(attachPickerProofOwner({ ...args, ...invalid }), "operationDenied");
            expect(await writerEpoch(sql)).toBe(original.writer);
            expect(fixture.connectionStarts()).toBe(baseline);
            expect(isFixtureChildAlive(original.terminal.pid)).toBe(receiptMode === "lost receipt");
          }

          const attached = await attachPickerProofOwner(args);
          try {
            expect(attached.ownerEpoch).toEqual(original.epoch);
            // Reattachment acknowledgement follows confirmed physical cleanup, not the disconnect flag alone.
            expect(isFixtureChildAlive(original.terminal.pid)).toBe(false);
            expect(await writerEpoch(sql)).not.toBe(original.writer);
            const stale = await Effect.runPromise(
              applySshOwnerTransition(sql, {
                writerEpoch: original.writer,
                targetId: options.targetId,
                requestId: "old-proof-writer",
                expectedSeq: 1,
                desiredState: "connected",
              }),
            );
            expect(stale).toEqual({ kind: "epochMismatch" });
            const list = picker(attached, fixture);
            await expect(list()).rejects.toMatchObject({ cause: { code: "targetDisconnected" } });
            expect(fixture.connectionStarts()).toBe(baseline);
            await attached.connect();
            await expect(list()).resolves.toMatchObject({ path: fixture.folder });
            const replacement = await openReadyTerminal(attached);
            expect(replacement.lease).not.toEqual(original.terminal.lease);
            await expect(
              attached.closeProofTerminal(original.terminal.lease),
            ).rejects.toMatchObject({
              code: "operationDenied",
            });
            expect(isFixtureChildAlive(replacement.pid)).toBe(true);
            await expect(attached.closeProofTerminal(replacement.lease)).resolves.toMatchObject({
              live: false,
            });
            expect(isFixtureChildAlive(replacement.pid)).toBe(false);

            // The original tracked process still owns the new client connection.
            await bootstrapOwner?.killForTest();
            await expect(list()).rejects.toMatchObject({ cause: { code: "ownerUnavailable" } });
          } finally {
            await attached.close();
          }
        }),
      );
    } finally {
      await bootstrapOwner?.killForTest();
      await bootstrapOwner?.close();
      await fixture.dispose();
    }
  },
  120_000,
);

it.skipIf(!pickerProofOptedIn)(
  "recovers a committed Connect after its storage reply is lost without dialing at reattachment",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    let bootstrap: LaunchedPickerProofOwner | undefined;
    try {
      const db = path.join(fixture.root, "connect-receipt.sqlite");
      const socketPath = path.join(fixture.root, "owner.sock");
      const capability = randomBytes(32);
      const options = await proofOptions(fixture, socketPath, false);
      await fixture.start();
      const attachment = {
        socketPath,
        capability,
        profileBinding: options.profileBinding,
        targetId: options.targetId,
      };
      const { ownerEpoch, receipt, baseline } = await storageScope(db, (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({ ...options, sql, attachment });
          bootstrap = owner;
          const trust = await owner.inspectTrust();
          if (trust.state !== "approvalRequired") throw new Error("Expected an unpinned host");
          await owner.approveTrust(trust.challenge);
          await owner.disconnect();
          const baseline = fixture.connectionStarts();
          await expect(picker(owner, fixture)()).rejects.toMatchObject({
            cause: { code: "targetDisconnected" },
          });
          await owner.detach();
          const receipt = await commitTransitionWithoutReply({
            ...attachment,
            sql,
            action: "connect",
          });
          expect(receipt.seq).toBe(2);
          expect(fixture.connectionStarts()).toBe(baseline);
          return { ownerEpoch: Uint8Array.from(owner.ownerEpoch), receipt, baseline };
        }),
      );
      await storageScope(db, (sql) =>
        Effect.promise(async () => {
          const attached = await attachPickerProofOwner({ ...attachment, sql });
          try {
            expect(attached.ownerEpoch).toEqual(ownerEpoch);
            expect(await writerEpoch(sql)).not.toBe(receipt.writerEpoch);
            const delayed = await Effect.runPromise(
              applySshOwnerTransition(sql, {
                writerEpoch: receipt.writerEpoch,
                targetId: options.targetId,
                requestId: "delayed-disconnect",
                expectedSeq: receipt.seq,
                desiredState: "disconnected",
              }),
            );
            expect(delayed).toEqual({ kind: "epochMismatch" });
            const [durable] = await Effect.runPromise(sql<{ disconnected: number; seq: number }>`
              SELECT EXISTS(
                SELECT 1 FROM remote_execution_target_disconnects WHERE target_id = ${options.targetId}
              ) AS disconnected, seq
              FROM ssh_target_transition WHERE target_id = ${options.targetId}
            `);
            expect(durable).toMatchObject({ disconnected: 0, seq: 2 });
            expect(fixture.connectionStarts()).toBe(baseline);
            await expect(picker(attached, fixture)()).resolves.toMatchObject({
              path: fixture.folder,
            });
            expect(fixture.connectionStarts()).toBe(baseline + 1);
          } finally {
            await attached.close();
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
