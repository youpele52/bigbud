import { expect, it } from "vitest";

import {
  readExternalV2Target,
  withProductionV2Owner,
} from "../provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.fixture.ts";
import { reserveWorkspaceMode } from "../remote-backend/workspaceMode.reserve.ts";
import {
  makeProductionSshWorkspaceModeStore,
  makeProductionWorkspaceModeSshOwner,
} from "../remote-backend/workspaceMode.ssh.production.ts";
import { runSshToolCommand } from "../tool-transport/toolTransport.ssh.ts";
import { makeProductionProviderWorkspaceShell } from "../ws/remoteWorkspaceProviderShell.ts";
import { makeSshMonitorSampler, productionSystemStatusSource } from "./sshMonitor.ts";
import { parseSshExecutionTarget } from "./sshExecutionTarget.ts";
import type { SshOwnerProductionRegistration } from "./sshOwnerProductionRegistry.ts";

// W7 live proof: a real target-free `bigbud-ssh-owner --production` against an
// already-running disposable sshd. Same target JSON as the T-term test:
// BIGBUD_TEST_SSH_OWNER_PRODUCTION_W7_TARGET='{"host":…,"port":…,"user":…,
//   "identityFile":…,"knownHostsFile":…,"cwd":…,"remoteBinary":"/unused"}'
// `cwd` must be an existing absolute folder the run may reserve.
const external = readExternalV2Target(process.env.BIGBUD_TEST_SSH_OWNER_PRODUCTION_W7_TARGET);
const enabled =
  external !== undefined && (process.platform === "darwin" || process.platform === "linux");
const backendOwner = `backend-v1:${"c".repeat(64)}`;

it.skipIf(!enabled)(
  "samples stats, reserves workspace mode and runs a tool command over the production owner",
  async () => {
    await withProductionV2Owner(
      external!,
      1,
      async ({ handle, targets }) => {
        const { descriptor: raw, cwd } = targets[0]!;
        const targetId = parseSshExecutionTarget(raw.targetId)!.executionTargetId;
        const descriptor = { ...raw, targetId };
        const bound = handle.target(descriptor);
        const trust = await bound.inspectTrust();
        if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
        const live = {
          handle,
          descriptorFor: async (id: string) => {
            if (id !== targetId) throw new Error(`unexpected target ${id}`);
            return descriptor;
          },
        } as unknown as SshOwnerProductionRegistration;

        // 1. Stats: one owner sample, then the bounded sampler with a CPU window.
        const raw1 = await bound.sampleSystemStatus();
        expect(raw1).toMatch(/^###OS###\nLinux\n/);
        expect(raw1).toMatch(/^###END###$/m);
        // Back-to-back master sessions: the exit is matched by session channel id.
        for (let round = 0; round < 10; round += 1) {
          expect(await bound.sampleSystemStatus()).toMatch(/^###END###$/m);
          expect(await bound.listTerminalShells()).toContain("/bin/sh");
        }
        const sample = makeSshMonitorSampler(productionSystemStatusSource(() => live));
        const started = Date.now();
        const first = await sample(targetId);
        expect(first.osName).toBe("Linux");
        expect(first.cpuPercent?.status).toBe("ready");
        expect(first.memoryTotalBytes?.value).toBeGreaterThan(0);
        expect(first.diskCapacityBytes?.status).toBe("ready");
        expect(first.processRows?.length).toBeGreaterThan(0);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(await sample(targetId)).toBe(first);

        // 2. Workspace mode: reserve, re-confirm as held, refuse a second backend.
        const owner = makeProductionWorkspaceModeSshOwner(() => live);
        const store = makeProductionSshWorkspaceModeStore(targetId, owner);
        const reserved = await reserveWorkspaceMode(store, cwd, "laptop-runtime", backendOwner);
        expect(reserved).toMatchObject({ kind: "reserved", record: { mode: "laptop-runtime" } });
        const again = await reserveWorkspaceMode(store, cwd, "laptop-runtime", backendOwner);
        expect(again).toEqual(reserved);
        const other = `backend-v1:${"d".repeat(64)}`;
        // A held laptop claim stays held for another laptop backend; a remote-runtime
        // request conflicts with it (decided from the owner's observation).
        expect(await reserveWorkspaceMode(store, cwd, "laptop-runtime", other)).toEqual(reserved);
        const refused = await reserveWorkspaceMode(store, cwd, "remote-runtime", other);
        expect(refused.kind).toBe("conflict");
        await expect(store.inspect(`${cwd}/missing-folder`)).rejects.toThrow(/does not exist/);

        // 3. Generic tool command: `sh -lc` over the provider workspace shell grant.
        const shellFor = (id: string, root: string) =>
          makeProductionProviderWorkspaceShell(id, root, () => live);
        const ran = await runSshToolCommand(
          {
            executionTargetId: targetId as never,
            cwd,
            command: "sh",
            args: ["-lc", "pwd; echo w7"],
          },
          shellFor,
        );
        expect(ran.stdout).toMatch(/w7\n$/);
        expect(ran.code).toBe(0);
        await expect(
          runSshToolCommand(
            { executionTargetId: targetId as never, cwd, command: "sh", args: ["-lc", "exit 3"] },
            shellFor,
          ),
        ).rejects.toThrow("code 3");
      },
      { binding: {} },
    );
  },
  120_000,
);
