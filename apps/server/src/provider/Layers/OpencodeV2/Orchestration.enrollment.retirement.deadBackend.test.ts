import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import {
  V2EnrollmentRetirement,
  type V2RetirementProof,
} from "./Orchestration.enrollment.retirement.ts";
import {
  provedDeadBackend,
  provedFencedLive,
  V2_DEAD_BACKEND_PROOF,
  type V2DeadBackendRetirementProof,
} from "./Orchestration.enrollment.retirement.deadBackend.ts";
import { ensureV2ReceiptFence } from "./Orchestration.instances.ts";
import { V2ThreadReceipts } from "./Orchestration.receipts.ts";

/** Frozen copy of the retirement proof validator shipped before this change (228464334). Older
 * builds run exactly this rule, so every new proof shape must fail it (fail closed). */
const legacyFields = [
  "physicalSettled",
  "controlsSettled",
  "callbacksSettled",
  "creationSettled",
  "admissionsSettled",
  "receiptsSettled",
] as const;
const legacyProved = (value: unknown): boolean =>
  Boolean(
    value &&
    typeof value === "object" &&
    Object.keys(value).length ===
      legacyFields.length + ((value as V2RetirementProof).rebootReceiptCheckpointDigest ? 1 : 0) &&
    legacyFields.every(
      (key) =>
        Object.hasOwn(value, key) &&
        ((value as V2RetirementProof)[key] === true ||
          (key === "receiptsSettled" &&
            (value as V2RetirementProof).receiptsSettled === false &&
            /^[a-f0-9]{64}$/.test(
              (value as V2RetirementProof).rebootReceiptCheckpointDigest ?? "",
            ))),
    ),
  );

const nonce = "a".repeat(32);
const flags = {
  physicalSettled: true,
  controlsSettled: true,
  callbacksSettled: true,
  creationSettled: true,
  admissionsSettled: true,
} as const;
const deadProof: V2DeadBackendRetirementProof = {
  kind: V2_DEAD_BACKEND_PROOF,
  settlingBackendInstance: nonce,
  settlingPid: 4242,
  ownerBackendInstance: null,
  nativeInactiveObservedAt: "2026-10-15T10:00:00.000Z",
  receiptFence: { instance: nonce, digest: "b".repeat(64) },
  receiptsSettled: false,
};
const fencedLive = {
  ...flags,
  receiptsSettled: false,
  deadBackendReceiptFence: { instance: nonce, digest: "b".repeat(64) },
};

it("new proof shapes are exact, versioned, and rejected by the frozen pre-change validator", () => {
  expect(provedDeadBackend(deadProof)).toBe(true);
  expect(provedDeadBackend({ ...deadProof, extra: true })).toBe(false);
  const { nativeInactiveObservedAt: _omitted, ...missing } = deadProof;
  expect(provedDeadBackend(missing)).toBe(false);
  expect(
    provedDeadBackend({
      ...deadProof,
      receiptFence: { ...deadProof.receiptFence, instance: "c".repeat(32) },
    }),
  ).toBe(false);
  expect(provedDeadBackend({ ...deadProof, kind: "owner-backend-dead" })).toBe(false);
  expect(provedFencedLive(fencedLive)).toBe(true);
  expect(provedFencedLive({ ...fencedLive, rebootReceiptCheckpointDigest: "d".repeat(64) })).toBe(
    true,
  );
  expect(provedFencedLive({ ...fencedLive, physicalSettled: false })).toBe(false);
  expect(provedFencedLive({ ...fencedLive, receiptsSettled: true })).toBe(false);
  expect(provedFencedLive({ ...fencedLive, extra: 1 })).toBe(false);
  // Older builds fail closed on both new shapes; the original shapes are still accepted there.
  expect(legacyProved(deadProof)).toBe(false);
  expect(legacyProved(fencedLive)).toBe(false);
  expect(legacyProved({ ...flags, receiptsSettled: true })).toBe(true);
});

async function withDetachedRetirement(
  run: (input: {
    retirement: V2EnrollmentRetirement;
    identity: Parameters<V2EnrollmentRetirement["settle"]>[0];
    receipts: V2ThreadRecords;
    enrollments: V2ThreadRecords;
  }) => Promise<void>,
) {
  const app = await makeV2ThreadPluginFixture();
  try {
    const enrollments = await V2ThreadRecords.open(
      app.artifact.root,
      "enrollments",
      app.artifact.privateKey,
      app.artifact.publicKey,
    );
    const identity = {
      wireProtocol: "bigbud.thread.enrollment.v2" as const,
      ownerDigest: "e".repeat(64),
      enrollmentNonce: "f".repeat(32),
      directory: "/owned",
      nativeSessionId: "ses_live_owner",
    };
    const retirement = await V2EnrollmentRetirement.open(enrollments);
    await retirement.begin(identity, { archived: true });
    const absent = {
      state: "missing" as const,
      ownerDigest: identity.ownerDigest,
      enrollmentNonce: identity.enrollmentNonce,
      revision: 0,
      expiry: 0,
    };
    await retirement.acknowledge(
      identity,
      { ...absent, state: "revoked" },
      absent,
      "d".repeat(64),
      "gen",
    );
    await run({
      retirement,
      identity,
      receipts: await enrollments.sibling("receipts"),
      enrollments,
    });
  } finally {
    await app.close();
  }
}

it("Q1: a live owner settles over dead-backend-fenced receipts but an unfenced reserved receipt still blocks", async () => {
  await withDetachedRetirement(async ({ retirement, identity, receipts, enrollments }) => {
    await receipts.replace("dead-call", undefined, { fingerprint: "dead", state: "reserved" });
    const fence = await ensureV2ReceiptFence(enrollments, { nonce });
    expect([...fence.receipts.keys()]).toHaveLength(1);
    // Without a fence (pre-change rule): the dead backend's receipt blocks live settlement.
    const unfencedEvidence = await new V2ThreadReceipts(receipts).retirementEvidence();
    expect(unfencedEvidence).toEqual({ receiptsSettled: false });
    expect(await retirement.settleIfProved(identity, { ...flags, ...unfencedEvidence })).toBe(
      false,
    );
    // A receipt reserved by this live instance after the fence still blocks exactly as before.
    const live = await receipts.replace("live-call", undefined, {
      fingerprint: "live",
      state: "reserved",
    });
    const fenced = new V2ThreadReceipts(receipts, fence);
    const blocked = await fenced.retirementEvidence();
    expect(blocked).toEqual({ receiptsSettled: false });
    expect(await retirement.settleIfProved(identity, { ...flags, ...blocked })).toBe(false);
    await expect(retirement.assertSettled(identity)).rejects.toThrow(
      "not durably physically settled",
    );
    // Once the live receipt completes, only fenced unknown outcomes remain: live settlement proceeds.
    await receipts.replace("live-call", live, {
      fingerprint: "live",
      state: "completed",
      result: { content: "{}" },
    });
    const evidence = await fenced.retirementEvidence();
    expect(evidence).toEqual({
      receiptsSettled: false,
      deadBackendReceiptFence: { instance: nonce, digest: fence.digest },
    });
    // A fence reference to other evidence is rejected at settlement.
    await expect(
      retirement.settle(identity, {
        ...flags,
        receiptsSettled: false,
        deadBackendReceiptFence: { instance: nonce, digest: "0".repeat(64) },
      }),
    ).rejects.toThrow("fence evidence is missing or changed");
    expect(await retirement.settleIfProved(identity, { ...flags, ...evidence })).toBe(true);
    await retirement.assertSettled(identity);
  });
});

it("a dead-backend proof must name this instance's exact signed fence", async () => {
  await withDetachedRetirement(async ({ retirement, identity, enrollments }) => {
    const fence = await ensureV2ReceiptFence(enrollments, { nonce });
    await expect(
      retirement.settle(identity, {
        ...deadProof,
        receiptFence: { instance: nonce, digest: "0".repeat(64) },
      }),
    ).rejects.toThrow("fence evidence is missing or changed");
    await retirement.settle(identity, {
      ...deadProof,
      receiptFence: { instance: nonce, digest: fence.digest },
    });
    await retirement.assertSettled(identity);
  });
});
