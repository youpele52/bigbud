import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import {
  V2EnrollmentRetirement,
  type V2RetirementProof,
} from "./Orchestration.enrollment.retirement.ts";

const settledProof: V2RetirementProof = {
  physicalSettled: true,
  controlsSettled: true,
  callbacksSettled: true,
  creationSettled: true,
  admissionsSettled: true,
  receiptsSettled: true,
};

it("reopening every persisted retirement phase preserves signed evidence and rejects successor acknowledgements/replacements", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const enrollments = await V2ThreadRecords.open(
      app.artifact.root,
      "enrollments",
      app.artifact.privateKey,
      app.artifact.publicKey,
    );
    const owner = app.bind("crash-owned-session", "/crash-owned-location"),
      signed = app.envelope("enroll", 4, Date.now() + 30000),
      identity = {
        wireProtocol: owner.protocol,
        ownerDigest: signed.ownerDigest,
        enrollmentNonce: owner.enrollmentNonce,
        directory: owner.directory,
        nativeSessionId: owner.nativeSessionId,
      };
    const inspected = {
      state: "active" as const,
      ownerDigest: identity.ownerDigest,
      enrollmentNonce: identity.enrollmentNonce,
      revision: 4,
      expiry: signed.leaseExpiresAt!,
    };
    const ack = { ...inspected, state: "revoked" as const },
      durable = await enrollments.sibling("retirements");
    let retirement = await V2EnrollmentRetirement.open(enrollments);
    await retirement.begin(identity, signed);
    retirement = await V2EnrollmentRetirement.open(enrollments);
    expect(await retirement.begin(identity, { mustNotReplace: signed })).toBe("retiring");
    await expect(retirement.settle(identity, settledProof)).rejects.toThrow("unproved");
    await expect(retirement.replacementBound(identity, "c".repeat(64))).rejects.toThrow(
      "not durably physically settled",
    );
    const original = await durable.entries();
    await expect(
      retirement.acknowledge(
        identity,
        { ...ack, revision: 5 },
        inspected,
        app.artifact.artifactDigest,
        "owned-generation",
      ),
    ).rejects.toThrow();
    expect(await durable.entries()).toEqual(original);
    await retirement.acknowledge(
      identity,
      ack,
      inspected,
      app.artifact.artifactDigest,
      "owned-generation",
    );
    retirement = await V2EnrollmentRetirement.open(enrollments);
    expect(await retirement.begin(identity, signed)).toBe("detach-acknowledged");
    const acknowledged = await durable.entries();
    for (const field of Object.keys(settledProof) as (keyof V2RetirementProof)[]) {
      const incomplete = { ...settledProof, [field]: false };
      expect(await retirement.settleIfProved(identity, incomplete)).toBe(false);
      await expect(retirement.settle(identity, incomplete)).rejects.toThrow("unproved");
      await expect(retirement.assertSettled(identity)).rejects.toThrow(
        "not durably physically settled",
      );
      expect(await durable.entries()).toEqual(acknowledged);
    }
    await retirement.settle(identity, settledProof);
    retirement = await V2EnrollmentRetirement.open(enrollments);
    expect(await retirement.begin(identity, signed)).toBe("settled");
    await retirement.assertSettled(identity);
    await retirement.replacementBound(identity, "c".repeat(64));
    retirement = await V2EnrollmentRetirement.open(enrollments);
    expect(await retirement.begin(identity, signed)).toBe("replacement-bound");
    const replaced = await durable.entries();
    await retirement.replacementBound(identity, "c".repeat(64));
    await expect(retirement.replacementBound(identity, "d".repeat(64))).rejects.toThrow(
      "replacement changed",
    );
    await expect(
      retirement.acknowledge(
        identity,
        { ...ack, enrollmentNonce: "e".repeat(32) },
        inspected,
        app.artifact.artifactDigest,
        "owned-generation",
      ),
    ).rejects.toThrow();
    expect(await durable.entries()).toEqual(replaced);
    expect(replaced[0]?.value).toMatchObject({
      phase: "replacement-bound",
      archivedSignedEnrollment: signed,
      proof: settledProof,
      detach: { ack, evidence: "exact-entry" },
      replacementDigest: "c".repeat(64),
    });
  } finally {
    await app.close();
  }
});
