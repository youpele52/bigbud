import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2PreHtmlRegistrationFixture } from "./Orchestration.registration.legacy.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { V2EnrollmentRetirement } from "./Orchestration.enrollment.retirement.ts";
import { v2ThreadOwnerDigest } from "./Orchestration.protocol.ts";
import { v2ThreadImplementation } from "./Orchestration.implementation.ts";
import { selectV2SessionArtifact } from "./Orchestration.selection.ts";

it("upgrades a scoped v3 history only after exact durable retirement, retaining original owners and supporting restart", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const old = await makeV2PreHtmlRegistrationFixture(app.artifact);
    const owner = {
      ...app.bind("retained-html-history", app.root),
      bootstrapDigest: old.bootstrapDigest,
      bootstrapAbi: old.bootstrapAbi,
      compatibilityDigest: old.compatibilityDigest,
      implementationDigest: v2ThreadImplementation("v1").implementationDigest,
    };
    const records = await V2ThreadRecords.open(
      app.artifact.root,
      "enrollments",
      app.artifact.privateKey,
      app.artifact.publicKey,
    );
    const digest = v2ThreadOwnerDigest(owner);
    const original = {
      owner,
      digest,
      state: "revoked",
      acknowledged: { revision: 1, expiry: 1 },
      pending: null,
    };
    const signed = await records.replace("old", undefined, original);
    const identity = {
      nativeSessionId: owner.nativeSessionId,
      threadId: owner.threadId,
      storageIdentity: owner.storageIdentity,
      directory: owner.directory,
      registrationFamily: "scoped" as const,
    };
    expect((await selectV2SessionArtifact(app.artifact, records, identity)).bootstrapDigest).toBe(
      old.bootstrapDigest,
    );
    const retirement = await V2EnrollmentRetirement.open(records);
    const retired = {
      wireProtocol: owner.protocol,
      ownerDigest: digest,
      enrollmentNonce: owner.enrollmentNonce,
      directory: owner.directory,
      nativeSessionId: owner.nativeSessionId,
    };
    await retirement.begin(retired, signed);
    const missing = {
      state: "missing" as const,
      ownerDigest: digest,
      enrollmentNonce: owner.enrollmentNonce,
      revision: 0,
      expiry: 0,
    };
    await retirement.acknowledge(
      retired,
      { ...missing, state: "revoked" },
      missing,
      old.bootstrapDigest,
      "synthetic-generation",
    );
    expect((await selectV2SessionArtifact(app.artifact, records, identity)).bootstrapDigest).toBe(
      old.bootstrapDigest,
    );
    await retirement.settle(retired, {
      physicalSettled: true,
      controlsSettled: true,
      callbacksSettled: true,
      creationSettled: true,
      admissionsSettled: true,
      receiptsSettled: true,
    });
    const before = await records.inventory();
    expect((await selectV2SessionArtifact(app.artifact, records, identity)).bootstrapDigest).toBe(
      app.artifact.bootstrapDigest,
    );
    expect(await records.inventory()).toEqual(before);
    const current = {
      ...owner,
      bootstrapDigest: app.artifact.bootstrapDigest,
      bootstrapAbi: app.artifact.bootstrapAbi,
      compatibilityDigest: app.artifact.compatibilityDigest,
      implementationDigest: v2ThreadImplementation().implementationDigest,
      enrollmentNonce: "a".repeat(32),
    };
    await records.replace("new", undefined, {
      owner: current,
      digest: v2ThreadOwnerDigest(current),
      state: "active",
      acknowledged: { revision: 1, expiry: Date.now() + 10000 },
      pending: null,
    });
    const reopened = await V2ThreadRecords.open(
      app.artifact.root,
      "enrollments",
      app.artifact.privateKey,
      app.artifact.publicKey,
    );
    expect((await selectV2SessionArtifact(app.artifact, reopened, identity)).bootstrapDigest).toBe(
      app.artifact.bootstrapDigest,
    );
    expect((await reopened.read("old"))?.value).toEqual(original);
  } finally {
    await app.close();
  }
});
