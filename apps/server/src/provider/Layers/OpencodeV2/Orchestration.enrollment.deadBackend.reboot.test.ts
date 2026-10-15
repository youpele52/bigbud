import path from "node:path";
import { expect, it } from "vitest";
import { acquireStateDirLock } from "../../../startup/stateDirLock.ts";
import { makeBackendInstance } from "../../../startup/backendInstance.ts";
import { assertV2PreviousHistoryRetired } from "./Orchestration.enrollment.recovery.ts";
import {
  prepareV2DeadBackendRecovery,
  type V2DeadBackendContext,
} from "./Orchestration.enrollment.deadBackend.ts";
import { V2_DEAD_BACKEND_PROOF } from "./Orchestration.enrollment.retirement.deadBackend.ts";
import { withV2DeadBackendScenario } from "./Orchestration.enrollment.restart.fixture.ts";
import { withRebootRecoveryFixture } from "./RebootRecovery.fixture.ts";
import { applyV2RebootRecovery, prepareV2RebootRecovery } from "./RebootRecovery.ts";
import { v2LegacyThreadOwnerDigest } from "./Orchestration.protocol.legacy.ts";
import type { OpencodeV2Client } from "./Client.ts";

type Retirement = {
  phase: string;
  rebootCheckpointDigest?: string;
  supersededRebootCheckpointDigest?: string;
  proof?: { kind?: string };
};
const retirements = async (records: { sibling: (name: "retirements") => Promise<unknown> }) =>
  (
    await (
      (await records.sibling("retirements")) as {
        entries: () => Promise<ReadonlyArray<{ value: unknown }>>;
      }
    ).entries()
  ).map((entry) => entry.value as Retirement);
const trap = () => {
  throw new Error("dead-backend recovery must not run for a valid reboot seal");
};

it("a sealed reboot retirement settles through the reboot path; dead-backend recovery never runs", async () => {
  await withRebootRecoveryFixture(async (f) => {
    await prepareV2RebootRecovery(f.prepare);
    f.reboot();
    await applyV2RebootRecovery(f.apply);
    const before = await retirements(f.enrollments);
    const context = {
      instance: { assertHeld: trap, classifyOwner: trap },
      nativeSessionActive: trap,
      rpc: trap,
    } as unknown as V2DeadBackendContext;
    const { legacy } = f;
    await assertV2PreviousHistoryRetired(
      f.enrollments,
      {
        storageIdentity: legacy.storageIdentity,
        nativeSessionId: legacy.nativeSessionId,
        threadId: legacy.threadId,
        directory: legacy.directory,
      },
      context,
    );
    expect(await retirements(f.enrollments)).toEqual(before);
    expect(before.map((value) => value.phase)).toEqual(["reboot-prepared"]);
  });
});

it("a stalled reboot (staged, never sealed; legacy v1 owner + reserved receipt, the user's shape) is superseded", async () => {
  await withRebootRecoveryFixture(async (f) => {
    await prepareV2RebootRecovery(f.prepare);
    f.reboot();
    f.failBeforeSeal();
    await expect(applyV2RebootRecovery(f.apply)).rejects.toThrow("simulated crash");
    const stateDir = path.dirname(f.artifact.root);
    const lock = await acquireStateDirLock({ stateDir, port: 0 });
    try {
      const { legacy } = f;
      const recoveryRecords = await f.enrollments.sibling("recovery");
      const checkpoint = await recoveryRecords.entries();
      const before = await retirements(f.enrollments);
      expect(before).toMatchObject([{ phase: "reboot-prepared" }]);
      const absent = {
        ownerDigest: v2LegacyThreadOwnerDigest(legacy),
        enrollmentNonce: legacy.enrollmentNonce,
        revision: 0,
        expiry: 0,
      };
      const calls: string[] = [];
      const client = {
        rpc: {
          call: async ({ method }: { method: string }) => {
            calls.push(method);
            return { output: { ...absent, state: method === "detach" ? "revoked" : "missing" } };
          },
        },
        session: { active: async () => ({}) },
      } as unknown as OpencodeV2Client;
      const recovery = (await prepareV2DeadBackendRecovery({
        stateDir,
        instance: makeBackendInstance(lock, stateDir),
        records: f.enrollments,
        privateKey: f.artifact.privateKey,
      }))!;
      await assertV2PreviousHistoryRetired(
        f.enrollments,
        {
          storageIdentity: legacy.storageIdentity,
          nativeSessionId: legacy.nativeSessionId,
          threadId: legacy.threadId,
          directory: legacy.directory,
        },
        recovery.context(client, "legacy-transport"),
      );
      expect(calls).toEqual(["inspect", "detach"]);
      const [after] = await retirements(f.enrollments);
      expect(after).toMatchObject({
        phase: "settled",
        supersededRebootCheckpointDigest: before[0]!.rebootCheckpointDigest,
        proof: { kind: V2_DEAD_BACKEND_PROOF },
      });
      expect(after!.rebootCheckpointDigest).toBeUndefined();
      expect(await recoveryRecords.entries()).toEqual(checkpoint); // Checkpoint bytes untouched.
      expect(await f.receipts.read("call")).toEqual(f.originalReceipt); // Never replayed.
    } finally {
      await lock.release();
    }
  });
});

it("a v2 owner whose reboot retirement lacks any checkpoint evidence is superseded", async () => {
  await withV2DeadBackendScenario(async (scenario) => {
    const { records, scope, owner, digest, key } = scenario;
    const identity = {
      wireProtocol: owner.protocol,
      ownerDigest: digest,
      enrollmentNonce: owner.enrollmentNonce,
      directory: owner.directory,
      nativeSessionId: owner.nativeSessionId,
    };
    await (
      await records.sibling("retirements")
    ).replace(JSON.stringify(Object.values(identity)), undefined, {
      format: "bigbud.thread.retirement.v1",
      identity,
      archivedSignedEnrollment: (await records.read(key))!,
      phase: "reboot-prepared",
      rebootCheckpointDigest: "a".repeat(64),
    });
    await expect(assertV2PreviousHistoryRetired(records, scope)).rejects.toThrow(
      "V2 reboot retirement has no exact sealed checkpoint evidence.",
    );
    await assertV2PreviousHistoryRetired(
      records,
      scope,
      (await scenario.recovery()).context(scenario.client, "dead-backend-transport"),
    );
    expect(await retirements(records)).toMatchObject([
      { phase: "settled", supersededRebootCheckpointDigest: "a".repeat(64) },
    ]);
  });
}, 60_000);
