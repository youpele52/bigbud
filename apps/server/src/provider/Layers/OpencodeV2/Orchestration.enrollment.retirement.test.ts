import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { V2EnrollmentRetirement } from "./Orchestration.enrollment.retirement.ts";

it("crash-reopened detach/registry absence cannot stand in for physical settlement; exact same-session replacement retains original signed evidence", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const enrollments = await V2ThreadRecords.open(
      app.artifact.root,
      "enrollments",
      app.artifact.privateKey,
      app.artifact.publicKey,
    );
    const owner = app.bind("native-same-session", "/owned-location"),
      signedEnvelope = app.envelope("enroll", 1, Date.now() + 10000);
    const identity = {
      wireProtocol: owner.protocol,
      ownerDigest: signedEnvelope.ownerDigest,
      enrollmentNonce: owner.enrollmentNonce,
      directory: owner.directory,
      nativeSessionId: owner.nativeSessionId,
    };
    let retired = await V2EnrollmentRetirement.open(enrollments);
    await retired.begin(identity, signedEnvelope);
    const inspected = {
      state: "missing" as const,
      ownerDigest: identity.ownerDigest,
      enrollmentNonce: identity.enrollmentNonce,
      revision: 0,
      expiry: 0,
    };
    await retired.acknowledge(
      identity,
      { ...inspected, state: "revoked" },
      inspected,
      app.artifact.artifactDigest,
      "owned-generation",
    );
    retired = await V2EnrollmentRetirement.open(enrollments);
    await expect(retired.assertSettled(identity)).rejects.toThrow("not durably physically settled");
    const proof = {
      physicalSettled: true,
      controlsSettled: true,
      callbacksSettled: true,
      creationSettled: true,
      admissionsSettled: true,
      receiptsSettled: false,
    };
    await expect(retired.settle(identity, proof)).rejects.toThrow("unproved");
    await retired.settle(identity, { ...proof, receiptsSettled: true });
    await retired.assertSettled(identity);
    await retired.replacementBound(identity, "f".repeat(64));
    await retired.assertSettled(identity);
    const evidence = await (await enrollments.sibling("retirements")).entries();
    expect(evidence[0]?.value).toMatchObject({
      phase: "replacement-bound",
      identity: { nativeSessionId: "native-same-session" },
      archivedSignedEnrollment: signedEnvelope,
    });
  } finally {
    await app.close();
  }
});
