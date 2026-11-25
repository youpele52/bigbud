import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";
import { makeSshOwnerDevPicker } from "./sshOwnerDevPicker.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";

const run = promisify(execFile);

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "keeps a native owner available to the remaining picker waiter after bootstrap cancellation",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture, undefined, false, true);
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      await storageScope(path.join(fixture.root, "bootstrap-waiters.sqlite"), (sql) =>
        Effect.promise(async () => {
          const bootstrapped = Promise.withResolvers<void>();
          const publish = Promise.withResolvers<void>();
          let starts = 0;
          const picker = makeSshOwnerDevPicker({
            executionTargetId: options.targetId,
            host: fixture.host,
            startOwner: async (profileBinding) => {
              starts++;
              const owner = await startPickerProofOwner({
                ...options,
                sql,
                profileBinding,
                posixPickerMaster: true,
              });
              bootstrapped.resolve();
              await publish.promise;
              return owner;
            },
          });
          const controller = new AbortController();
          const target = { executionTargetId: options.targetId, path: fixture.folder };
          const first = picker.listRemoteFolders(target, controller.signal);
          void first.catch(() => undefined);
          try {
            await Promise.race([bootstrapped.promise, first]);
            const second = picker.listRemoteFolders(target);
            void second.catch(() => undefined);
            controller.abort();
            await expect(first).rejects.toThrow(/aborted/i);
            expect(fixture.connectionStarts()).toBe(0);
            publish.resolve();
            await expect(second).resolves.toMatchObject({ path: fixture.folder });
            await expect(picker.listRemoteFolders(target)).resolves.toMatchObject({
              path: fixture.folder,
            });
            expect(starts).toBe(1);
            expect(fixture.acceptedPublicKeys()).toBe(1);
            expect(fixture.connectionStarts()).toBe(1);
          } finally {
            publish.resolve();
            await picker.close();
          }
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);

it.skipIf(process.platform !== "darwin" || process.env.BIGBUD_TEST_SSH_OWNER_POSIX_MASTER !== "1")(
  "authenticates, verifies, and reaps only the owner-created key master on disposable sshd",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      const result = await run(
        "cargo",
        [
          "test",
          "--offline",
          "--locked",
          "-p",
          "bigbud-ssh-owner",
          "--bin",
          "bigbud-ssh-owner",
          "stock_master_is_checked_reaped_and_does_not_adopt_an_outside_master",
          "--",
          "--ignored",
          "--nocapture",
        ],
        {
          cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
          env: {
            ...process.env,
            BIGBUD_POSIX_MASTER_FIXTURE: "approved-disposable",
            BIGBUD_POSIX_MASTER_FIXTURE_ROOT: fixture.root,
            BIGBUD_POSIX_MASTER_FIXTURE_PORT: String(fixture.port),
            BIGBUD_POSIX_MASTER_FIXTURE_USER: fixture.user,
          },
          timeout: 90_000,
          killSignal: "SIGKILL",
        },
      );
      expect(result.stdout).toContain("1 passed; 0 failed");
    } finally {
      await fixture.dispose();
    }
  },
  120_000,
);
