import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";

const approved = process.env.BIGBUD_TEST_JUMP_STORAGE === "approved-disposable";
const binary = process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN;
const runner = fileURLToPath(
  new URL("../../../../protocol/ssh-owner/live-jump-fixture.sh", import.meta.url),
);
const targetId = "ssh:host=workspace&auth=ssh-key&transport=direct-ssh";
const target = { executionTargetId: targetId };

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function fixture(driver: string, name: string, source: string) {
  const root = await mkdtemp("/tmp/bigbud-picker-linux-");
  const launcher = path.join(driver, name);
  try {
    const args = [runner, "--serve", root, source].map(shellQuote);
    await writeFile(
      launcher,
      `#!/bin/sh\nexport BIGBUD_SSH_OWNER_LIVE_JUMP=approved-disposable\nexec /bin/sh ${args.join(" ")} "$@"\n`,
      { mode: 0o700, flag: "wx" },
    );
  } catch (cause) {
    await rm(root, { recursive: true, force: true });
    throw cause;
  }
  return {
    root,
    launcher,
    dispose: () => rm(root, { recursive: true, force: true }),
    countAuth: async (log: "b.log" | "d.log") =>
      (await readFile(path.join(root, log), "utf8")).match(/Accepted publickey/g)?.length ?? 0,
    leases: async () => (await readdir(root)).filter((name) => name.startsWith("bbcm-")),
  };
}

it.skipIf(process.platform !== "linux" || !approved)(
  "persists jump Disconnect in real SQLite and refuses a fresh owner until explicit Connect",
  async () => {
    if (!binary || !path.isAbsolute(binary))
      throw new Error("Expected an absolute Linux owner binary.");
    const driver = await mkdtemp("/tmp/bigbud-jump-storage-");
    const roots: Array<Awaited<ReturnType<typeof fixture>>> = [];
    try {
      const db = path.join(driver, "storage.sqlite");
      for (const previousDisconnect of [false, true]) {
        const isolated = await fixture(driver, previousDisconnect ? "restart" : "initial", binary);
        roots.push(isolated);
        await storageScope(db, (sql) =>
          Effect.promise(async () => {
            const flags = sql<{
              target_id: string;
            }>`SELECT target_id FROM remote_execution_target_disconnects`;
            const picker = makeSshOwnerDevPicker({
              executionTargetId: targetId,
              host: "[127.0.0.1]:22223",
              startOwner: (profileBinding) =>
                startPickerProofOwner({
                  binary: isolated.launcher,
                  profileBinding,
                  targetId,
                  sql,
                  lockFile: path.join(isolated.root, "owner.lock"),
                  sshBinary: "/usr/bin/ssh",
                  keyscanBinary: "/usr/bin/ssh-keyscan",
                  host: "127.0.0.1",
                  port: 22223,
                  user: "picker",
                  identityFile: path.join(isolated.root, "d-identity"),
                  knownHostsFile: path.join(isolated.root, "d-pins"),
                  aliasConfig: { file: path.join(isolated.root, "ssh-config"), alias: "workspace" },
                }),
            });
            try {
              if (previousDisconnect) {
                expect(await Effect.runPromise(flags)).toEqual([{ target_id: targetId }]);
                await expect(picker.listRemoteFolders(target)).rejects.toThrow(/disconnected/i);
                expect(await isolated.countAuth("b.log")).toBe(0);
                expect(await isolated.countAuth("d.log")).toBe(0);
                expect(await isolated.leases()).toEqual([]);
                await picker.connectExecutionTarget(target);
                expect(await Effect.runPromise(flags)).toEqual([]);
                expect(await isolated.countAuth("b.log")).toBe(0);
                const bastionPins = path.join(isolated.root, "b-pins");
                const validPin = await readFile(bastionPins, "utf8");
                const destinationPin = await readFile(path.join(isolated.root, "d-pins"), "utf8");
                await writeFile(bastionPins, destinationPin.replace(":22223 ", ":22222 "));
                await expect(picker.listRemoteFolders(target)).rejects.toMatchObject({
                  code: "sshHostKeyChanged",
                  message: expect.stringContaining("SSH route hop 1 failed while connecting"),
                });
                expect(await isolated.countAuth("b.log")).toBe(0);
                expect(await isolated.countAuth("d.log")).toBe(0);
                await writeFile(bastionPins, validPin);
                await picker.connectExecutionTarget(target);
              }
              await expect(picker.listRemoteFolders(target)).resolves.toMatchObject({
                folders: [{ name: "jump-fixture-folder", isGitRepo: false }],
              });
              expect(await isolated.countAuth("b.log")).toBe(1);
              expect(await isolated.countAuth("d.log")).toBe(1);
              expect(await isolated.leases()).toHaveLength(2);
              await picker.disconnectExecutionTarget(target);
              expect(await Effect.runPromise(flags)).toEqual([{ target_id: targetId }]);
              expect(await isolated.leases()).toEqual([]);
            } finally {
              await picker.close();
            }
          }),
        );
      }
    } finally {
      await Promise.all(roots.map((isolated) => isolated.dispose()));
      await rm(driver, { recursive: true, force: true });
    }
  },
  60_000,
);
