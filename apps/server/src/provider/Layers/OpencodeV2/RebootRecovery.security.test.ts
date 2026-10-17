import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withRebootRecoveryFixture } from "./RebootRecovery.fixture.ts";
import { applyV2RebootRecovery, prepareV2RebootRecovery } from "./RebootRecovery.ts";
import { assertV2PluginUpgradeIdle } from "./PluginSetup.upgrade.ts";
import { checkpointKey, settlementKey } from "./RebootRecovery.schema.ts";
import { V2ThreadReceipts } from "./Orchestration.receipts.ts";
import { V2EnrollmentRetirement } from "./Orchestration.enrollment.retirement.ts";
import { v2LegacyThreadOwnerDigest } from "./Orchestration.protocol.legacy.ts";

it("pending physical controls and unspecified receipts prevent preparation", async () => {
  await withRebootRecoveryFixture(async (f) => {
    await expect(prepareV2RebootRecovery({ ...f.prepare, receiptNames: [] })).rejects.toThrow(
      "selected receipt",
    );
    await f.change("owner");
    await expect(prepareV2RebootRecovery(f.prepare)).rejects.toThrow("pending controls");
  });
});

it.each([checkpointKey, settlementKey])(
  "tampering %s cannot release ownership or clear receipt uncertainty",
  async (key) => {
    await withRebootRecoveryFixture(async (f) => {
      await prepareV2RebootRecovery(f.prepare);
      f.reboot();
      if (key === settlementKey) await applyV2RebootRecovery(f.apply);
      const store = await f.enrollments.sibling("recovery");
      const filename = path.join(store.directory, createHash("sha256").update(key).digest("hex"));
      const value = JSON.parse(await readFile(filename, "utf8"));
      value.value.issuer = "f".repeat(64);
      await writeFile(filename, JSON.stringify(value));
      await expect(applyV2RebootRecovery(f.apply)).rejects.toThrow("signed record rejected");
      expect(await new V2ThreadReceipts(f.receipts).unsettledCount()).toBe(1);
      await expect(assertV2PluginUpgradeIdle(f.artifact)).rejects.toThrow();
    });
  },
);

it("signed but mismatched settlement and pointer records are not proof", async () => {
  await withRebootRecoveryFixture(async (f) => {
    await prepareV2RebootRecovery(f.prepare);
    f.reboot();
    await applyV2RebootRecovery(f.apply);
    const store = await f.enrollments.sibling("recovery");
    const old = (await store.read(settlementKey))!;
    await store.replace(settlementKey, old.revision, {
      ...(old.value as object),
      checkpointDigest: "f".repeat(64),
    });
    await expect(assertV2PluginUpgradeIdle(f.artifact)).rejects.toThrow("seal/host changed");
  });
});

it("resurrected exact ownership and newly reserved receipts never inherit the checkpoint's settlement", async () => {
  await withRebootRecoveryFixture(async (f) => {
    await prepareV2RebootRecovery(f.prepare);
    f.reboot();
    await applyV2RebootRecovery(f.apply);
    await f.receipts.replace("other-call", undefined, { fingerprint: "other", state: "reserved" });
    expect(await new V2ThreadReceipts(f.receipts).retirementEvidence()).toEqual({
      receiptsSettled: false,
    });
    await f.change("owner");
    await expect(assertV2PluginUpgradeIdle(f.artifact)).rejects.toThrow("resurrected");
  });
});

it("normal native detach still needs all physical proof; reboot-fenced uncertainty is explicit, never receiptsSettled=true", async () => {
  await withRebootRecoveryFixture(async (f) => {
    await prepareV2RebootRecovery(f.prepare);
    f.reboot();
    await applyV2RebootRecovery(f.apply);
    const owner = { ...f.legacy, threadId: "next", enrollmentNonce: "c".repeat(32) };
    await f.addOwner(owner);
    const records = await f.enrollments.sibling("retirements");
    const retirement = await V2EnrollmentRetirement.open(f.enrollments);
    const identity = {
      wireProtocol: owner.protocol,
      ownerDigest: v2LegacyThreadOwnerDigest(owner),
      enrollmentNonce: owner.enrollmentNonce,
      directory: owner.directory,
      nativeSessionId: owner.nativeSessionId,
    };
    const archive = await f.enrollments.read(
      JSON.stringify([owner.storageIdentity, owner.nativeSessionId, owner.threadId]),
    );
    await retirement.begin(identity, archive);
    const inspected = {
      state: "missing" as const,
      ownerDigest: identity.ownerDigest,
      enrollmentNonce: identity.enrollmentNonce,
      revision: 0,
      expiry: 0,
    };
    await retirement.acknowledge(
      identity,
      { ...inspected, state: "revoked" },
      inspected,
      f.artifact.artifactDigest,
      "new-native",
    );
    const proof = {
      physicalSettled: true,
      controlsSettled: true,
      callbacksSettled: true,
      creationSettled: true,
      admissionsSettled: true,
      ...(await new V2ThreadReceipts(f.receipts).retirementEvidence()),
    };
    await expect(
      retirement.settle(identity, { ...proof, callbacksSettled: false }),
    ).rejects.toThrow("unproved");
    await expect(retirement.settle(identity, { ...proof, receiptsSettled: true })).rejects.toThrow(
      "unknown receipt",
    );
    await retirement.settle(identity, proof);
    await retirement.assertSettled(identity);
    const values = (await records.entries()).map((signed) => signed.value);
    expect(values).toContainEqual(
      expect.objectContaining({
        proof: expect.objectContaining({
          receiptsSettled: false,
          rebootReceiptCheckpointDigest: expect.any(String),
        }),
      }),
    );
  });
});

it("revocation while checking native activity prevents retirement staging", async () => {
  await withRebootRecoveryFixture(async (f) => {
    await prepareV2RebootRecovery(f.prepare);
    f.reboot();
    let revoked = false;
    await expect(
      applyV2RebootRecovery({
        ...f.apply,
        assertCurrent: () => {
          if (revoked) throw new Error("revoked");
        },
        assertIdle: async () => {
          revoked = true;
        },
      }),
    ).rejects.toThrow("revoked");
    expect(await (await f.enrollments.sibling("retirements")).entries()).toEqual([]);
  });
});
