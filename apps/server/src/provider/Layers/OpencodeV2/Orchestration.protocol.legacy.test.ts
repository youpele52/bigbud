import { expect, it } from "vitest";
import {
  v2LegacyThreadOwnerDigest,
  v2LegacyThreadEnvelopeBytes,
  signV2LegacyCleanup,
} from "./Orchestration.protocol.legacy.ts";
import { createHash, verify } from "node:crypto";
import type {
  V2LegacyThreadOwner,
  V2LegacyThreadEnvelope,
} from "./Orchestration.protocol.legacy.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";

it("legacy vectors/signatures are byte-exact frozen encoding and new-app issuance is inspect/detach only", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const owner: V2LegacyThreadOwner = {
      protocol: "bigbud.thread.v1",
      issuer: app.artifact.issuer,
      artifactDigest: "a".repeat(64),
      threadId: "thread",
      nativeSessionId: "native",
      storageIdentity: "storage",
      directory: "/fixture-location",
      runtimeTargetId: "local",
      workspaceTargetId: "local",
      sessionEpoch: 0,
      transportGeneration: "generation",
      consentRevision: 1,
      enrollmentNonce: "b".repeat(32),
      callbackUrl: "http://127.0.0.1:1234/invoke",
      callbackToken: "c".repeat(64),
    };
    const ownerBytes = JSON.stringify([
      "bigbud.thread.v1",
      app.artifact.issuer,
      "a".repeat(64),
      "thread",
      "native",
      "storage",
      "/fixture-location",
      "local",
      "local",
      0,
      "generation",
      1,
      "b".repeat(32),
      "http://127.0.0.1:1234/invoke",
      "c".repeat(64),
    ]);
    expect(v2LegacyThreadOwnerDigest(owner)).toBe(
      createHash("sha256").update(ownerBytes).digest("hex"),
    );
    for (const operation of ["inspect", "detach"] as const) {
      const original: Omit<V2LegacyThreadEnvelope, "signature"> = {
        protocol: "bigbud.thread.v1",
        operation,
        issuer: owner.issuer,
        ownerDigest: v2LegacyThreadOwnerDigest(owner),
        enrollmentNonce: owner.enrollmentNonce,
        requestId: "d".repeat(32),
        authExpiresAt: 123456789,
        leaseRevision: null,
        leaseExpiresAt: null,
        owner: null,
      };
      const bytes = Buffer.from(
        JSON.stringify([
          "bigbud.thread.v1",
          operation,
          owner.issuer,
          original.ownerDigest,
          owner.enrollmentNonce,
          "d".repeat(32),
          123456789,
          null,
          null,
          null,
        ]),
      );
      expect(v2LegacyThreadEnvelopeBytes(original)).toEqual(bytes);
      expect(
        verify(
          null,
          bytes,
          app.artifact.publicKey,
          Buffer.from(
            signV2LegacyCleanup(original, app.artifact.privateKey).signature,
            "base64url",
          ),
        ),
      ).toBe(true);
    }
    for (const operation of ["enroll", "renew"] as const)
      expect(() =>
        signV2LegacyCleanup(
          {
            protocol: "bigbud.thread.v1",
            operation,
            issuer: owner.issuer,
            ownerDigest: v2LegacyThreadOwnerDigest(owner),
            enrollmentNonce: owner.enrollmentNonce,
            requestId: "d".repeat(32),
            authExpiresAt: Date.now() + 14000,
            leaseRevision: 1,
            leaseExpiresAt: Date.now() + 10000,
            owner: operation === "enroll" ? owner : null,
          },
          app.artifact.privateKey,
        ),
      ).toThrow("cleanup-only");
  } finally {
    await app.close();
  }
});
