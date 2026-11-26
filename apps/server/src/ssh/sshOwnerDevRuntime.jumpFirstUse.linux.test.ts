import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { bindLinuxDevJump } from "./sshOwnerDevRuntime.jump.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";

const approved =
  process.platform === "linux" && process.env.BIGBUD_TEST_JUMP_STORAGE === "approved-disposable";

function challenge(result: Promise<unknown>, hop: number) {
  return result.then(
    () => {
      throw new Error("Expected an explicit routed trust challenge");
    },
    (error: unknown) => {
      if (!(error instanceof Error) || !error.message.startsWith(SSH_HOST_TRUST_REQUIRED_PREFIX))
        throw error;
      const value = JSON.parse(error.message.slice(SSH_HOST_TRUST_REQUIRED_PREFIX.length));
      expect(value).toMatchObject({
        host: `SSH jump route hop ${hop}`,
        keyType: "ssh-ed25519",
        fingerprint: expect.stringMatching(/^SHA256:[A-Za-z0-9+/]{43}$/),
      });
      return value.challengeId as string;
    },
  );
}

it.skipIf(!approved)(
  "requires independent first-use approval before authenticating each jump leg",
  async () => {
    const binary = process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN;
    if (!binary || !path.isAbsolute(binary))
      throw new Error("Expected an absolute Linux owner binary.");
    const profile = await mkdtemp("/tmp/bigbud-ssh-owner-dev-");
    try {
      await storageScope(path.join(profile, "storage.sqlite"), (sql) =>
        Effect.promise(async () => {
          const session = await bindLinuxDevJump(profile, binary, sql, true);
          const target = { executionTargetId: session.targetId };
          const file = (name: string) => readFile(path.join(session.fixture.root, name), "utf8");
          const auth = async () =>
            Promise.all(
              ["b.log", "d.log"].map(
                async (name) => (await file(name)).match(/Accepted publickey/g)?.length ?? 0,
              ),
            );
          const browse = () => session.picker.listRemoteFolders(target);
          const approve = (challengeId: string) =>
            session.picker.trustSshHost({ ...target, challengeId });
          try {
            const canceled = await challenge(browse(), 1);
            await session.picker.trustSshHost({ ...target, challengeId: canceled, cancel: true });
            await expect(approve(canceled)).rejects.toThrow(/invalid|expired/i);
            const stale = await challenge(browse(), 1);
            expect(await auth()).toEqual([0, 0]);
            expect(await file("b-pins")).toBe("");
            expect(await file("d.log")).not.toMatch(/Connection from/);
            await session.picker.disconnectExecutionTarget(target);
            await expect(approve(stale)).rejects.toThrow(/invalid|expired/i);
            await expect(browse()).rejects.toThrow(/disconnected/i);
            expect(await file("b-pins")).toBe("");
            await session.picker.connectExecutionTarget(target);

            await approve(await challenge(browse(), 1));
            expect(await auth()).toEqual([0, 0]);
            expect(await file("b-pins")).toMatch(/ssh-ed25519 /);
            expect(await file("d-pins")).toBe("");
            expect(await file("d.log")).not.toMatch(/Connection from/);

            const staleDestination = await challenge(browse(), 2);
            expect((await auth())[1]).toBe(0);
            expect(await file("d-pins")).toBe("");
            const differentPin = (await file("b-pins")).replace(":22222 ", ":22223 ");
            const destinationPins = path.join(session.fixture.root, "d-pins");
            await writeFile(destinationPins, differentPin);
            await expect(approve(staleDestination)).rejects.toThrow(/host key changed/i);
            expect(await file("d-pins")).toBe(differentPin);
            expect((await auth())[1]).toBe(0);
            await writeFile(destinationPins, "");

            const destination = await challenge(browse(), 2);
            await approve(destination);
            expect((await auth())[1]).toBe(0);
            await expect(approve(destination)).rejects.toThrow(/invalid|expired/i);
            expect(await file("d-pins")).toMatch(/ssh-ed25519 /);
            await expect(browse()).resolves.toMatchObject({
              folders: [{ name: "jump-fixture-folder", isGitRepo: false }],
            });
            expect((await auth())[1]).toBe(1);

            await session.picker.disconnectExecutionTarget(target);
            await session.picker.connectExecutionTarget(target);
            await writeFile(destinationPins, "");
            const retargeted = await challenge(browse(), 2);
            const beforeRetarget = await auth();
            const aliasConfig = path.join(session.fixture.root, "ssh-config");
            const configuration = await file("ssh-config");
            await writeFile(
              aliasConfig,
              configuration.replace("HostName 127.0.0.1", "HostName 127.0.0.2"),
            );
            await expect(approve(retargeted)).rejects.toThrow(
              /settings.*unsupported|settings.*changed/i,
            );
            await expect(browse()).rejects.toMatchObject({ code: "sshConfigUnsupported" });
            expect(await auth()).toEqual(beforeRetarget);
            expect(await file("d-pins")).toBe("");
          } finally {
            await session.close();
          }
        }),
      );
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
  60_000,
);
