import { expect, it } from "vitest";
import { runV2RequestContext } from "./Client.guard.ts";
import { assertV2PreviousHistoryRetired } from "./Orchestration.enrollment.recovery.ts";
import { V2ThreadEnrollment } from "./Orchestration.enrollment.ts";
import { V2EnrollmentRetirement } from "./Orchestration.enrollment.retirement.ts";
import { V2_DEAD_BACKEND_PROOF } from "./Orchestration.enrollment.retirement.deadBackend.ts";
import { readV2OwnerMarker } from "./Orchestration.instances.ts";
import { V2ThreadReceipts } from "./Orchestration.receipts.ts";
import {
  withV2DeadBackendScenario,
  type V2DeadBackendScenario,
} from "./Orchestration.enrollment.restart.fixture.ts";

const TRANSPORT = "dead-backend-transport";
const identityOf = ({ owner, digest }: V2DeadBackendScenario) => ({
  wireProtocol: owner.protocol,
  ownerDigest: digest,
  enrollmentNonce: owner.enrollmentNonce,
  directory: owner.directory,
  nativeSessionId: owner.nativeSessionId,
});
const retirementValue = async (scenario: V2DeadBackendScenario) => {
  const entries = await (await scenario.records.sibling("retirements")).entries();
  expect(entries).toHaveLength(1);
  return entries[0]!.value as {
    phase: string;
    proof?: Record<string, unknown>;
    detach?: { evidence: string };
  };
};
const contextOf = async (scenario: V2DeadBackendScenario) =>
  (await scenario.recovery()).context(scenario.client, TRANSPORT)!;

/** Uncertain work of the dead backend is preserved and never replayed. */
async function expectReceiptNeverReplayed(scenario: V2DeadBackendScenario) {
  const receipts = new V2ThreadReceipts(await scenario.records.sibling("receipts"));
  expect(await receipts.durableState(scenario.receiptKey)).toBe("reserved");
  await expect(receipts.find(scenario.receiptKey, "f".repeat(64))).rejects.toThrow(
    "no automatic re-execution",
  );
}

it("entry 1: a thread enrolled by a SIGKILLed backend is sendable after restart when the native session is idle", async () => {
  await withV2DeadBackendScenario(async (scenario) => {
    const { records, scope, backendA, lock } = scenario;
    expect(backendA.nonce).not.toBe(lock.record.nonce);
    await expect(assertV2PreviousHistoryRetired(records, scope)).rejects.toThrow(
      "V2 previous owner retirement is not durably physically settled; no replacement or history replay.",
    );
    await assertV2PreviousHistoryRetired(records, scope, await contextOf(scenario));
    expect(scenario.calls).toEqual(["inspect", "detach"]);
    const retirement = await retirementValue(scenario);
    expect(retirement.phase).toBe("settled");
    expect(retirement.detach?.evidence).toBe("exact-entry");
    expect(retirement.proof).toMatchObject({
      kind: V2_DEAD_BACKEND_PROOF,
      settlingBackendInstance: lock.record.nonce,
      ownerBackendInstance: null, // Legacy owner without attribution (the user's records' shape).
      receiptsSettled: false,
    });
    await expectReceiptNeverReplayed(scenario);
    // Settled: a later send passes the original rule without any native call.
    await assertV2PreviousHistoryRetired(records, scope);
    expect(scenario.calls).toEqual(["inspect", "detach"]);
  });
}, 60_000);

it("entry 2: the replacement enrollment recovers an attributed dead owner, enrolls natively and binds the replacement", async () => {
  await withV2DeadBackendScenario(
    async (scenario) => {
      const { app, records, owner, backendA, lock } = scenario;
      expect((await readV2OwnerMarker(records, scenario.digest))?.backendInstance).toBe(
        backendA.nonce,
      );
      const recovery = await scenario.recovery();
      const replacement = app.bind(owner.nativeSessionId, owner.directory);
      const enrollment = new V2ThreadEnrollment({
        records,
        privateKey: app.artifact.privateKey,
        owner: replacement,
        client: scenario.client,
        transport: TRANSPORT,
        assertCurrent: () => {},
        deadBackend: recovery.context(scenario.client, TRANSPORT),
        recordOwner: recovery.recordOwner,
      });
      await runV2RequestContext(
        {
          transport: TRANSPORT,
          intent: "execute",
          permit: {
            revision: 1,
            signal: new AbortController().signal,
            assertCurrent: () => {},
            release: () => {},
          },
        },
        () => enrollment.start(),
      );
      expect(scenario.calls).toEqual(["inspect", "detach", "enroll"]);
      const retirement = await retirementValue(scenario);
      expect(retirement.phase).toBe("replacement-bound");
      expect(retirement.proof).toMatchObject({ ownerBackendInstance: backendA.nonce });
      expect((await readV2OwnerMarker(records, enrollment.digest))?.backendInstance).toBe(
        lock.record.nonce,
      );
      enrollment.assertLive();
      await expectReceiptNeverReplayed(scenario);
    },
    { marker: true },
  );
}, 60_000);

it("a retirement left 'retiring' by an interrupted shutdown is completed by the successor", async () => {
  await withV2DeadBackendScenario(async (scenario) => {
    const saved = (await scenario.records.read(scenario.key))!;
    await (await V2EnrollmentRetirement.open(scenario.records)).begin(identityOf(scenario), saved);
    await assertV2PreviousHistoryRetired(
      scenario.records,
      scenario.scope,
      await contextOf(scenario),
    );
    expect((await retirementValue(scenario)).phase).toBe("settled");
  });
}, 60_000);

it("an OpenCode daemon restart (registry absent) is accepted as native release evidence", async () => {
  await withV2DeadBackendScenario(async (scenario) => {
    await scenario.restartPlugin();
    await assertV2PreviousHistoryRetired(
      scenario.records,
      scenario.scope,
      await contextOf(scenario),
    );
    expect((await retirementValue(scenario)).detach?.evidence).toBe("registry-absent");
  });
}, 60_000);

it("an expired native lease of the dead owner is accepted as native release evidence", async () => {
  await withV2DeadBackendScenario(
    async (scenario) => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await assertV2PreviousHistoryRetired(
        scenario.records,
        scenario.scope,
        await contextOf(scenario),
      );
      expect((await retirementValue(scenario)).phase).toBe("settled");
    },
    { expiryMs: 2000 },
  );
}, 60_000);

it("concurrent sends on one thread recover exactly once", async () => {
  await withV2DeadBackendScenario(async (scenario) => {
    const context = await contextOf(scenario);
    await Promise.all([
      assertV2PreviousHistoryRetired(scenario.records, scenario.scope, context),
      assertV2PreviousHistoryRetired(scenario.records, scenario.scope, context),
      assertV2PreviousHistoryRetired(scenario.records, scenario.scope, context),
    ]);
    expect(scenario.calls).toEqual(["inspect", "detach"]);
    expect((await retirementValue(scenario)).phase).toBe("settled");
  });
}, 60_000);
