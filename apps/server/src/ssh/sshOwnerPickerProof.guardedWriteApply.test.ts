import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { initializeDevSshGuardedWriteJournal } from "../persistence/Layers/DevSshGuardedWriteJournal.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.fixture.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { applyGuardedWriteWithJournal } from "./sshOwnerPickerProof.guardedWriteJournal.ts";
import { MAX_GUARDED_WRITE_BYTES } from "./sshOwnerPickerProof.guardedWriteStage.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

async function makeApplyFixture() {
  if (process.platform === "linux") {
    const fixture = await makeLinuxLoopbackPickerFixture({ observeKeyDaemon: true });
    return {
      ...fixture,
      outsideRoot: fixture.home,
      async ownerOptions() {
        const binary = await fixture.installOwner(
          fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
          { guardedApplyProof: true },
        );
        const { loopback: host, port, user } = fixture;
        const targetId = `ssh:${new URLSearchParams({ host, port: String(port), user })}`;
        await writeFile(
          fixture.knownHosts,
          `${fixture.host} ${await fixture.getHostPublicKey()}\n`,
          {
            mode: 0o600,
          },
        );
        return {
          binary,
          targetId,
          host,
          port,
          user,
          profileBinding: randomBytes(32),
          lockFile: path.join(fixture.root, "owner.lock"),
          sshBinary: fixture.ssh,
          keyscanBinary: fixture.keyscan,
          identityFile: fixture.identity,
          knownHostsFile: fixture.knownHosts,
          workspaceRoot: fixture.folder,
        };
      },
      async expectConnections(count: number) {
        const log = await fixture.readKeyDaemonLog();
        expect(log.match(/^Connection from /gm) ?? []).toHaveLength(count);
        expect(log.match(/^Accepted publickey /gm) ?? []).toHaveLength(count);
      },
      expectOwnerClosed: undefined,
    };
  }
  const fixture = await makeLoopbackPickerFixture();
  return {
    ...fixture,
    outsideRoot: undefined,
    async ownerOptions() {
      const options = await proofOptions(fixture, undefined, true);
      const binary = path.join(fixture.root, "start-guarded-apply-owner");
      await writeFile(
        binary,
        `#!/bin/sh\nexport BIGBUD_SSH_OWNER_GUARDED_WRITE_APPLY_PROOF=approved-disposable\nexec '${options.binary}' "$@"\n`,
        { mode: 0o700, flag: "wx" },
      );
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      return { ...options, binary, workspaceRoot: fixture.folder, devInteractiveTerminal: true };
    },
    async expectConnections(count: number) {
      expect(fixture.connectionStarts()).toBe(count);
    },
    async expectOwnerClosed() {
      expect(await fixture.launchNames()).toEqual([]);
    },
  };
}

const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

it.skipIf(!["darwin", "linux"].includes(process.platform) || !pickerProofOptedIn)(
  "journals a real guarded SSH save, rejects a conflicting base, and does not replay a withheld receipt after reopen",
  async () => {
    const fixture = await makeApplyFixture();
    try {
      const options = await fixture.ownerOptions();
      const file = path.join(fixture.folder, "draft.txt");
      await writeFile(file, "base\n");
      await fixture.start();
      activateDevSshOwner();
      const db = path.join(fixture.root, "guarded-apply.sqlite");
      const input = {
        profileId: fixture.root,
        targetId: options.targetId,
        cwd: fixture.folder,
        relativePath: "draft.txt",
        operationId: "large-save",
        baseSha256: sha("base\n"),
        contents: new Uint8Array(MAX_GUARDED_WRITE_BYTES).fill(65),
      };
      const withheld = {
        ...input,
        operationId: "withheld-result",
        baseSha256: sha(input.contents),
        contents: Buffer.from("﻿new café\r\n"),
      };
      await storageScope(db, (sql) =>
        Effect.gen(function* () {
          const journal = yield* initializeDevSshGuardedWriteJournal(sql);
          const outsideRoot = fixture.outsideRoot;
          if (outsideRoot !== undefined) {
            yield* Effect.promise(async () => {
              const outsideFile = path.join(outsideRoot, input.relativePath);
              await writeFile(outsideFile, "base\n", { flag: "wx" });
              const unqualified = await startPickerProofOwner({
                ...options,
                sql,
                workspaceRoot: outsideRoot,
              });
              try {
                await expect(
                  applyGuardedWriteWithJournal(journal, unqualified, {
                    ...input,
                    cwd: outsideRoot,
                    operationId: "outside-fixture",
                  }),
                ).rejects.toMatchObject({ code: "operationDenied" });
                expect(await readFile(outsideFile, "utf8")).toBe("base\n");
                await fixture.expectConnections(0);
              } finally {
                await unqualified.close();
              }
            });
          }
          const owner = yield* Effect.acquireRelease(
            Effect.promise(() => startPickerProofOwner({ ...options, sql })),
            (value) => Effect.promise(value.close),
          );
          yield* Effect.promise(async () => {
            await expect(applyGuardedWriteWithJournal(journal, owner, input)).resolves.toEqual({
              kind: "saved",
              resultSha256: sha(input.contents),
            });
            expect(await readFile(file)).toEqual(Buffer.from(input.contents));
            await expect(
              applyGuardedWriteWithJournal(journal, owner, {
                ...input,
                operationId: "stale-base",
                contents: Buffer.from("never written"),
              }),
            ).resolves.toEqual({ kind: "conflict", currentSha256: sha(input.contents) });
            expect(await readFile(file)).toEqual(Buffer.from(input.contents));
            const consumer = {
              async applyProofGuardedWrite(
                ...args: Parameters<typeof owner.applyProofGuardedWrite>
              ) {
                const result = await owner.applyProofGuardedWrite(...args);
                expect(result.kind).toBe("saved");
                throw new Error(
                  "Fixture withheld the native save result from the journal coordinator",
                );
              },
            };
            await expect(
              applyGuardedWriteWithJournal(journal, consumer, withheld),
            ).resolves.toEqual({ kind: "unknown" });
            expect(await readFile(file)).toEqual(withheld.contents);
            await fixture.expectConnections(3);
          });
        }).pipe(Effect.scoped),
      );
      await storageScope(db, (sql) =>
        Effect.gen(function* () {
          const journal = yield* initializeDevSshGuardedWriteJournal(sql);
          const owner = {
            applyProofGuardedWrite: vi.fn(async () => {
              throw new Error("unexpected replay");
            }),
          };
          yield* Effect.promise(async () => {
            await expect(applyGuardedWriteWithJournal(journal, owner, withheld)).resolves.toEqual({
              kind: "unknown",
            });
            await expect(
              applyGuardedWriteWithJournal(journal, owner, {
                ...withheld,
                contents: Buffer.from("different binding"),
              }),
            ).rejects.toMatchObject({ code: "operationDenied" });
            expect(owner.applyProofGuardedWrite).not.toHaveBeenCalled();
            expect(await readFile(file)).toEqual(withheld.contents);
            await fixture.expectConnections(3);
            await fixture.expectOwnerClosed?.();
          });
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  90_000,
);
