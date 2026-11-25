import { symlink } from "node:fs/promises";
import path from "node:path";
import { text } from "node:stream/consumers";

import { ApprovalRequestId, ThreadId } from "@bigbud/contracts/core/baseSchemas";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vitest";

import { startPickerProofOwner } from "../ssh/sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "../ssh/sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "../ssh/sshPicker.loopback.fixture.ts";
import { makeAcpTerminalCwdProofObserver } from "./remoteWorkspaceAcpTerminal.owner.proof.ts";
import {
  issueAcpTerminalCommandApproval,
  observeOwnedAcpCwd,
  type AcpOwnerCommand,
} from "./remoteWorkspaceAcpTerminal.owner.ts";

it.skipIf(!pickerProofOptedIn || process.platform !== "darwin")(
  "observes the exact physical cwd through the Rust owner on a disposable macOS loopback fixture",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const targetId = fixture.executionTargetId.replace("transport=agent", "transport=direct-ssh");
      const workspaceRoot = fixture.folder;
      const cwd = path.join(workspaceRoot, "Z repo");
      const alias = path.join(workspaceRoot, "alias");
      await symlink(cwd, alias);
      const options = await proofOptions(fixture);
      await fixture.start();
      vi.stubEnv("PATH", fixture.env.PATH);
      vi.stubEnv("HOME", fixture.home);
      await storageScope(path.join(fixture.root, "acp-cwd-proof.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({ ...options, targetId, workspaceRoot, sql });
          try {
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired") throw new Error("Expected fixture first use");
            await owner.approveTrust(trust.challenge);
            const observer = makeAcpTerminalCwdProofObserver({
              targetId,
              workspaceRoot,
              withOwner: async (target, use) => {
                expect(target).toBe(targetId);
                return use(owner);
              },
            });
            const signal = new AbortController().signal;
            const command = (requestId: string, requestedCwd: string): AcpOwnerCommand => ({
              executionTargetId: targetId,
              workspaceRoot,
              cwd: requestedCwd,
              operation: "print-working-directory",
              approval: {
                requestId: ApprovalRequestId.makeUnsafe(requestId),
                threadId: ThreadId.makeUnsafe("fixture-thread"),
                sessionEpoch: 1,
                acpSessionId: "fixture-session",
                toolCallId: `call-${requestId}`,
              },
            });
            const request = command("exact", cwd);
            const selection = {
              observer,
              signal,
              identity: request.approval,
              approval: issueAcpTerminalCommandApproval({ ...request, decision: "accept" }),
            };
            const input = { ...request, command: "pwd" };
            const observation = await observeOwnedAcpCwd(input, selection);
            await expect(observeOwnedAcpCwd(input, selection)).rejects.toMatchObject({
              code: "approval-required",
            });
            expect(observation.kind).toBe("cwd-observation");
            await expect(text(observation.output)).resolves.toBe(`${cwd}\n`);
            await expect(
              observer.observeAcpCwd(command("aliased", alias), signal),
            ).rejects.toMatchObject({
              code: "workspacePathDenied",
            });
            await vi.waitFor(() => expect(fixture.acceptedPublicKeys()).toBe(2));
            await owner.disconnect();
            const disconnected = fixture.connectionStarts();
            await expect(
              observer.observeAcpCwd(command("disconnected", cwd), signal),
            ).rejects.toMatchObject({
              code: "targetDisconnected",
            });
            expect(fixture.connectionStarts()).toBe(disconnected);
            expect(await fixture.launchNames()).toEqual([]);
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  30_000,
);
