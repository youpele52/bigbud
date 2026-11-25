import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "cancels an active direct health probe without treating cancellation as transport failure",
  async () => {
    const fixture = await makeLoopbackPickerFixture({ pauseFirstPickerCommand: true });
    try {
      const options = await proofOptions(fixture);
      await writeFile(fixture.knownHosts, `${fixture.host} ${fixture.hostPublicKey}\n`, {
        mode: 0o600,
      });
      await fixture.start();
      await storageScope(path.join(fixture.root, "health-cancel.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            ...options,
            sql,
            posixPickerCancellation: true,
          });
          const id = fixture.executionTargetId;
          const controller = new AbortController();
          const epoch = owner.ownerEpoch;
          const release = path.join(fixture.root, "release-picker-read");
          try {
            await expect(
              owner.sampleCancellableProofHealth(id, AbortSignal.abort()),
            ).rejects.toMatchObject({ code: "healthCancelled" });
            expect(fixture.connectionStarts()).toBe(0);
            const active = owner.sampleCancellableProofHealth(id, controller.signal);
            void active.catch(() => undefined);
            await vi.waitFor(async () =>
              expect((await lstat(path.join(fixture.root, "held-picker-read"))).isDirectory()).toBe(
                true,
              ),
            );
            const start = performance.now();
            controller.abort();
            await expect(active).rejects.toMatchObject({ code: "healthCancelled" });
            expect(performance.now() - start).toBeLessThan(2_000);
            expect(fixture.connectionStarts()).toBe(1);

            // Local SSH cleanup does not establish termination of the peer command.
            await writeFile(release, "");
            await expect(owner.sampleProofHealth(id)).resolves.toBe(true);
            expect(owner.ownerEpoch).toEqual(epoch);
            expect(fixture.connectionStarts()).toBe(2);
            expect(await fixture.launchNames()).toEqual([]);
          } finally {
            controller.abort();
            await writeFile(release, "");
            await owner.close();
          }
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);
