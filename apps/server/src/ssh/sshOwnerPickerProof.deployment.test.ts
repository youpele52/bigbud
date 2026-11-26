import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { expect, it } from "vitest";

import {
  REMOTE_PROBE_SCRIPT,
  READ_COMPLETION_SCRIPT,
  readRemoteSetupCompletion,
  probeRemoteBackendHost,
} from "../remote-backend/deployment.remoteSetup.ts";
import { makeDeploymentSshRunner } from "../remote-backend/deployment.ssh.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import { deploymentForPickerProof } from "./sshOwnerPickerProof.deployment.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

it("keeps the installed legacy and built-in owner deployment observations identical", async () => {
  const bundled = await readFile(
    new URL("../../../../protocol/ssh-owner/deployment-host-probe.sh", import.meta.url),
    "utf8",
  );
  expect(bundled).toBe(REMOTE_PROBE_SCRIPT);
  const completion = await readFile(
    new URL("../../../../protocol/ssh-owner/deployment-read-completion.sh", import.meta.url),
    "utf8",
  );
  expect(completion).toBe(READ_COMPLETION_SCRIPT);
});

const liveLinux =
  process.platform === "linux" && process.env.BIGBUD_TEST_SSH_OWNER_PICKER_PROOF === "1";

it.skipIf(!liveLinux)(
  "reads the fixed deployment observation through a pinned native Linux SSH owner",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture();
    try {
      const binary = await fixture.installOwner(
        fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
        { mountDeploymentPublicKey: true },
      );
      const executionTargetId = `ssh:${new URLSearchParams({ host: fixture.loopback, port: String(fixture.port), user: fixture.user })}`;
      const requestId = randomUUID();
      const authority = "a".repeat(32);
      const receiptDir = path.join(fixture.home, ".bigbud", "backend-services", authority);
      await mkdir(receiptDir, { recursive: true });
      const receiptFile = path.join(receiptDir, "setup-complete-v1");
      const observedAuthority = {
        authorityId: authority,
        keyEpoch: 1,
        keyFingerprint: `sha256:${"b".repeat(64)}`,
      };
      const installationFingerprint = `sha256:${"c".repeat(64)}`;
      const sample = JSON.stringify({
        requestId,
        authority: observedAuthority,
        installationFingerprint,
      });
      await writeFile(receiptFile, sample);
      const publicKey = (await readFile(path.join(fixture.root, "host-key.pub"), "utf8"))
        .trim()
        .split(" ")
        .slice(0, 2)
        .join(" ");
      const sha256 = createHash("sha256").update(`${publicKey}\n`).digest("hex");

      await storageScope(path.join(fixture.root, "deployment-probe.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({
            binary,
            sql,
            profileBinding: randomBytes(32),
            targetId: executionTargetId,
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
            const run = makeDeploymentSshRunner({
              kind: "owner",
              owner: deploymentForPickerProof(owner),
            });
            const probe = () =>
              probeRemoteBackendHost(
                run,
                executionTargetId,
                requestId,
                new AbortController().signal,
              );
            await expect(probe()).rejects.toThrow("SSH host identity could not be verified");
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired")
              throw new Error("Expected fixture trust approval");
            await owner.approveTrust(trust.challenge);
            await expect(probe()).resolves.toEqual({
              home: fixture.home,
              target:
                process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu",
              hostIdentity: `sha256:${sha256}`,
              completedAuthorityId: authority,
            });
            const completion = {
              run,
              executionTargetId,
              requestId,
              authorityId: authority,
              signal: new AbortController().signal,
            };
            await expect(readRemoteSetupCompletion(completion)).resolves.toEqual({
              authority: observedAuthority,
              installationFingerprint,
            });
            await expect(
              readRemoteSetupCompletion({ ...completion, requestId: randomUUID() }),
            ).rejects.toMatchObject({ code: "conflict" });
            await expect(
              readRemoteSetupCompletion({ ...completion, authorityId: "../escape" }),
            ).rejects.toMatchObject({ code: "invalid-target" });
            expect(await readFile(receiptFile, "utf8")).toBe(sample);
            await owner.disconnect();
            await expect(probe()).rejects.toThrow("SSH owner refused this deployment operation");
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
