import { chmod, lstat, mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";

import { Effect } from "effect";
import { expect, it } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "refuses an unverified residual mux lease before attaching or rotating the database writer",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    let connections = 0;
    const listener = createServer((client) => {
      connections++;
      client.destroy();
    });
    try {
      const options = await proofOptions(fixture, undefined, false, true);
      const residual = path.join(fixture.root, "bbcm-ABCDEF123456");
      await mkdir(residual, { mode: 0o700 });
      const socketPath = path.join(residual, "s");
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(socketPath, () => {
          listener.off("error", reject);
          resolve();
        });
      });
      await chmod(socketPath, 0o600);
      const inode = (await lstat(socketPath)).ino;
      await fixture.start();
      await storageScope(path.join(fixture.root, "picker-orphan-fence.sqlite"), (sql) =>
        Effect.gen(function* () {
          for (const master of [false, true]) {
            yield* Effect.promise(async () => {
              const attempt = startPickerProofOwner({
                ...options,
                sql,
                ...(master ? { posixPickerMaster: true } : {}),
              });
              await expect(
                attempt.then(async (unexpected) => {
                  await unexpected.close();
                }),
              ).rejects.toMatchObject({ code: "ownerUnavailable" });
            });
          }
          const writers = yield* sql<{
            count: number;
          }>`SELECT COUNT(*) AS count FROM ssh_owner_writer`;
          expect(writers[0]?.count).toBe(0);
        }),
      );
      expect(fixture.connectionStarts()).toBe(0);
      expect(connections).toBe(0);
      expect((await lstat(socketPath)).ino).toBe(inode);
      expect(listener.listening).toBe(true);
    } finally {
      if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
      await fixture.dispose();
    }
  },
  120_000,
);
