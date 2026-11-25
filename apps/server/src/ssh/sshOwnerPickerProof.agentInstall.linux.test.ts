import { createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  MAX_AGENT_ACTION_ARTIFACT_BYTES,
  type AgentActionArtifact,
} from "./sshOwnerPickerProof.codec.agentAction.ts";
import { storageScope } from "./sshOwnerPickerProof.integration.ts";
import { makeLinuxLoopbackPickerFixture } from "./sshPicker.loopback.fixture.linux.ts";

const optedIn =
  process.platform === "linux" && process.env.BIGBUD_TEST_SSH_OWNER_PICKER_PROOF === "1";
const buildDir = new URL("../../../../target/debug/", import.meta.url);
const triple = process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";

/**
 * Written but skipped without a Linux fixture. Real installs also need E7
 * verified workspace-agent bytes; this case proves the bounded owner recipe,
 * artifact identity, placement and the no-replay contract.
 */
it.skipIf(!optedIn)(
  "installs one bounded verified artifact through the owner and never replays it",
  async () => {
    const fixture = await makeLinuxLoopbackPickerFixture();
    try {
      const binary = await fixture.installOwner(new URL("bigbud-ssh-owner", buildDir).pathname);
      const targetId = `ssh:${fixture.host}`;
      await storageScope(path.join(fixture.root, "agent-install.sqlite"), (sql) =>
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

            const bytes = Buffer.from("#!/bin/sh\nprintf 'bounded-fixture-agent\\n'\n");
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            const artifact: AgentActionArtifact = {
              version: "0.3.3",
              sha256,
              size: bytes.length,
              targetTriple: triple,
              bytes,
            };
            const operationId = randomBytes(16);
            const installed = await owner.runAgentAction({
              executionTargetId: targetId,
              action: "install",
              operationId,
              artifact,
            });
            expect(installed).toMatchObject({
              action: "install",
              exitCode: 0,
              outcomeUnknown: false,
              reattached: false,
            });
            const placed = path.join(
              fixture.home,
              ".bigbud/agent/bin",
              artifact.version,
              sha256,
              "bigbud-remote-agent",
            );
            await expect(readFile(placed)).resolves.toEqual(bytes);
            expect((await stat(placed)).mode & 0o777).toBe(0o700);

            // The same operation id returns the recorded outcome, never a rerun.
            const replay = await owner.runAgentAction({
              executionTargetId: targetId,
              action: "install",
              operationId,
              reattach: true,
            });
            expect(replay).toMatchObject({
              exitCode: installed.exitCode,
              stdout: installed.stdout,
              reattached: true,
            });

            // Oversize artifact bytes are refused before dispatch.
            const oversize = {
              ...artifact,
              size: MAX_AGENT_ACTION_ARTIFACT_BYTES + 1,
              bytes: Buffer.alloc(MAX_AGENT_ACTION_ARTIFACT_BYTES + 1),
            };
            await expect(
              owner.runAgentAction({
                executionTargetId: targetId,
                action: "install",
                operationId: randomBytes(16),
                artifact: oversize,
              }),
            ).rejects.toMatchObject({ code: "invalidOperands" });

            const removed = await owner.runAgentAction({
              executionTargetId: targetId,
              action: "remove",
              operationId: randomBytes(16),
            });
            expect(removed).toMatchObject({ exitCode: 0, outcomeUnknown: false });
            await expect(stat(path.join(fixture.home, ".bigbud/agent"))).rejects.toThrow();
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
