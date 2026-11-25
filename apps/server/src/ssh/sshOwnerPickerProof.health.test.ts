import path from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import {
  forgetSshMonitorTarget,
  isConnectedSshMonitorTarget,
  recordVerifiedSshMonitorTarget,
  sshMonitorLease,
} from "./sshMonitor.connections.ts";
import type { SshMonitorHealthOwner } from "./sshMonitor.healthOwner.ts";
import { makeSelectedSshMonitorHealth } from "./sshMonitor.healthOwner.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn)(
  "the owner-backed monitor differentiates an unavailable sample from observed connection failure",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    const targetId = fixture.executionTargetId.replace("transport=agent", "transport=direct-ssh");
    const caller = "isolated-health:1";
    try {
      const options = await proofOptions(fixture);
      await fixture.start();
      vi.stubEnv("HOME", fixture.home);
      vi.stubEnv("PATH", fixture.env.PATH);
      vi.useFakeTimers({ toFake: ["Date"] });
      const expire = () => vi.setSystemTime(Date.now() + 5_001);
      await storageScope(path.join(fixture.root, "health-proof.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({ ...options, targetId, sql });
          try {
            const health: SshMonitorHealthOwner = {
              async sampleHealth(id) {
                try {
                  return (await owner.sampleProofHealth(id)) ? "reachable" : "unreachable";
                } catch {
                  return "unavailable";
                }
              },
            };
            const connected = () => isConnectedSshMonitorTarget(targetId, caller, health);
            recordVerifiedSshMonitorTarget(targetId, caller);
            const lease = sshMonitorLease(targetId, caller);
            expect(lease).not.toBeNull();
            expire();
            const attempts = fixture.connectionStarts();
            await expect(connected()).resolves.toBe(false);
            expect(fixture.connectionStarts()).toBe(attempts);
            expect(sshMonitorLease(targetId, caller)).toBe(lease);
            const trust = await owner.inspectTrust();
            if (trust.state !== "approvalRequired")
              throw new Error("Expected fixture trust approval");
            await owner.approveTrust(trust.challenge);
            await expect(connected()).resolves.toBe(true);
            expect(sshMonitorLease(targetId, caller)).toBe(lease);
            await fixture.stop();
            expire();
            await expect(connected()).resolves.toBe(false);
            expect(sshMonitorLease(targetId, caller)).toBeNull();
            await fixture.start();
            recordVerifiedSshMonitorTarget(targetId, caller);
            const replacement = sshMonitorLease(targetId, caller);
            expect(replacement).not.toBeNull();
            const beforeOwnerLoss = fixture.connectionStarts();
            await owner.killForTest();
            expire();
            await expect(connected()).resolves.toBe(false);
            expect(sshMonitorLease(targetId, caller)).toBe(replacement);
            expect(fixture.connectionStarts()).toBe(beforeOwnerLoss);
            expect(await fixture.launchNames()).toEqual([]);
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      forgetSshMonitorTarget(targetId);
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  120_000,
);

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "fans one typed status to independent subscribers without another dial or legacy launch",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    const targetId = fixture.executionTargetId.replace("transport=agent", "transport=direct-ssh");
    try {
      const options = await proofOptions(fixture);
      await fixture.start();
      vi.stubEnv("HOME", fixture.home);
      vi.stubEnv("PATH", fixture.env.PATH);
      await storageScope(path.join(fixture.root, "health-subscribe.sqlite"), (sql) =>
        Effect.promise(async () => {
          const owner = await startPickerProofOwner({ ...options, targetId, sql });
          try {
            const trust = await owner.inspectTrust();
            if (trust.state === "approvalRequired") await owner.approveTrust(trust.challenge);
            const health = makeSelectedSshMonitorHealth(
              targetId,
              fixture.folder,
              async (id, _sample, signal) => {
                signal.throwIfAborted();
                return owner.sampleProofHealth(id);
              },
            );
            const first = health.subscribeStatus();
            const second = health.subscribeStatus();
            const before = fixture.connectionStarts();
            await expect(health.sampleHealth(targetId, new AbortController().signal)).resolves.toBe(
              "reachable",
            );
            const afterFirst = fixture.connectionStarts();
            expect(afterFirst - before).toBeLessThanOrEqual(1);
            expect(first.drain()).toMatchObject([
              { kind: "status", status: { targetId, sample: "reachable" } },
            ]);
            // The second reader stalls. Its backlog stays bounded to one
            // resync plus the newest status, and draining never dials.
            await health.sampleHealth(targetId, new AbortController().signal);
            await health.sampleHealth(targetId, new AbortController().signal);
            const backlog = second.drain();
            expect(backlog).toHaveLength(2);
            expect(backlog[0]).toMatchObject({ kind: "resync", reason: "overflow" });
            expect(backlog[1]).toMatchObject({
              kind: "status",
              status: { targetId, sample: "reachable" },
            });
            expect(fixture.connectionStarts()).toBeGreaterThanOrEqual(afterFirst);
            const beforeDrain = fixture.connectionStarts();
            expect(first.drain().length).toBeGreaterThan(0);
            expect(fixture.connectionStarts()).toBe(beforeDrain);
            // Cancelling one subscriber leaves the other receiving.
            first.close();
            await health.sampleHealth(targetId, new AbortController().signal);
            expect(second.drain().some((event) => event.kind === "status")).toBe(true);
            expect(await fixture.launchNames()).toEqual([]);
            health.closeStatus();
          } finally {
            await owner.close();
          }
        }),
      );
    } finally {
      forgetSshMonitorTarget(targetId);
      vi.unstubAllEnvs();
      await fixture.dispose();
    }
  },
  120_000,
);
