import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { prepareProofOwner } from "./sshOwnerPickerProof.posixPassword.fixture.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

const masters = async (root: string) =>
  (await readdir(root)).filter((name) => name.startsWith("bbcm-"));

/**
 * U2: the owner refuses a destination whose only configured method is
 * keyboard-interactive. The decision comes from the OpenSSH method list that
 * the fixture forces at startup, never from prompt text. The supplied secret
 * (standing in for a one-time code) is wiped and never released: no askpass
 * listener, master or destination connection exists.
 */
it.skipIf(process.platform !== "linux" || !pickerProofOptedIn)(
  "refuses keyboard-interactive-only from method configuration and never releases the OTP",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture({ syntheticPassword: true });
    try {
      await writeFile(fixture.knownHosts, `${fixture.host} ${await fixture.getHostPublicKey()}\n`, {
        mode: 0o600,
      });
      const { options, targetId } = await prepareProofOwner(fixture, {
        keyboardInteractiveProof: true,
      });
      await storageScope(path.join(fixture.root, "keyboard-interactive.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({ ...options, sql });
          try {
            // Positive-path OTP: refused before any password or prompt exists.
            await expect(owner.unlockSyntheticPosixPassword()).rejects.toMatchObject({
              code: "keyboardInteractiveUnsupported",
            });
            // Negative OTP: a second distinct attempt is refused identically;
            // nothing was cached or released by the first.
            await expect(owner.unlockSyntheticPosixPassword()).rejects.toMatchObject({
              code: "keyboardInteractiveUnsupported",
            });
            const log = await fixture.readPasswordDaemonLog();
            expect(log).not.toMatch(/^Connection from /m);
            expect(log).not.toMatch(/^Accepted /m);
            expect(await masters(fixture.root)).toEqual([]);
            // The same owner still refuses a password-backed read; no fallback.
            await expect(
              owner.listRemoteFolders({ executionTargetId: targetId, path: fixture.folder }),
            ).rejects.toMatchObject({ code: "authRequired" });
            expect(await fixture.readPasswordDaemonLog()).not.toMatch(/^Connection from /m);
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
