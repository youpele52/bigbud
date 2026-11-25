import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { picker, pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { prepareProofOwner } from "./sshOwnerPickerProof.posixPassword.fixture.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

it.skipIf(process.platform !== "linux" || !pickerProofOptedIn)(
  "does not dial via direct health before password unlock or around an owned password lease",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture({ syntheticPassword: true });
    try {
      await writeFile(fixture.knownHosts, `${fixture.host} ${await fixture.getHostPublicKey()}\n`, {
        mode: 0o600,
      });
      const { options, targetId } = await prepareProofOwner(fixture);
      await storageScope(path.join(fixture.root, "password-health.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({ ...options, sql });
          try {
            const health = () => owner.sampleProofHealth(targetId);
            const read = picker(owner, { ...fixture, executionTargetId: targetId });
            const starts = async () =>
              (await fixture.readPasswordDaemonLog()).match(/^Connection from /gm)?.length ?? 0;
            await expect(health()).rejects.toMatchObject({ code: "operationDenied" });
            expect(await starts()).toBe(0);
            await owner.unlockSyntheticPosixPassword();
            await expect(read()).resolves.toMatchObject({ path: fixture.folder });
            await vi.waitFor(async () => {
              expect(await fixture.readPasswordDaemonLog()).toMatch(
                /^Accepted password for picker /m,
              );
              expect(await starts()).toBe(1);
            });
            await expect(health()).rejects.toMatchObject({ code: "operationDenied" });
            await expect(read()).resolves.toMatchObject({ path: fixture.folder });
            await owner.disconnect();
            await expect(health()).rejects.toMatchObject({ code: "operationDenied" });
            await expect(read()).rejects.toMatchObject({ cause: { code: "targetDisconnected" } });
            expect(await starts()).toBe(1);
          } finally {
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
