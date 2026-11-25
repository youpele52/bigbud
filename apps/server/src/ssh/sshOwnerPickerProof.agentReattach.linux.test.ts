import { randomBytes } from "node:crypto";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

const optedIn =
  process.platform === "linux" && process.env.BIGBUD_TEST_SSH_OWNER_PICKER_PROOF === "1";
const buildDir = new URL("../../../../target/debug/", import.meta.url);

/**
 * Written but skipped without a Linux fixture. A transport-loss ack cannot be
 * forced deterministically here, so that half remains written-not-run; the
 * recorded-outcome and unknown-id halves run against the live owner.
 */
it.skipIf(!optedIn)(
  "reattaches a known agent operation and refuses an unknown reattach",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture();
    try {
      const binary = await fixture.installOwner(new URL("bigbud-ssh-owner", buildDir).pathname);
      const targetId = `ssh:${fixture.host}`;
      await storageScope(path.join(fixture.root, "agent-reattach.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            binary,
            sql,
            profileBinding: randomBytes(32),
            targetId,
            lockFile: path.join(fixture.root, "owner.lock"),
            sshBinary: fixture.ssh,
            keyscanBinary: fixture.keyscan,
            host: fixture.loopback,
            port: fixture.port,
            user: fixture.user,
            identityFile: fixture.identity,
            knownHostsFile: fixture.knownHosts,
          });
          try {
            const trust = await owner.inspectTrust();
            if (trust.state === "approvalRequired") await owner.approveTrust(trust.challenge);

            const operationId = randomBytes(16);
            const first = await owner.runAgentAction({
              executionTargetId: targetId,
              action: "status",
              operationId,
            });
            expect(first).toMatchObject({ action: "status", exitCode: 0, reattached: false });

            const known = await owner.runAgentAction({
              executionTargetId: targetId,
              action: "status",
              operationId,
              reattach: true,
            });
            expect(known).toEqual({ ...first, reattached: true });

            // An id this owner never accepted is refused; it never becomes a run.
            await expect(
              owner.runAgentAction({
                executionTargetId: targetId,
                action: "status",
                operationId: randomBytes(16),
                reattach: true,
              }),
            ).rejects.toMatchObject({ code: "operationDenied" });

            // The same id under a different verb is a different operation.
            await expect(
              owner.runAgentAction({
                executionTargetId: targetId,
                action: "wake",
                operationId,
                reattach: true,
              }),
            ).rejects.toMatchObject({ code: "operationDenied" });

            // Without a reattach request an unseen id is a normal new operation.
            const fresh = await owner.runAgentAction({
              executionTargetId: targetId,
              action: "platformProbe",
              operationId: randomBytes(16),
            });
            expect(fresh).toMatchObject({
              action: "platformProbe",
              exitCode: 0,
              reattached: false,
            });
            expect(fresh.stdout.split("\n")[0]).toBe("Linux");
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
